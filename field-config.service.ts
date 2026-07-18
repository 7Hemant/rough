import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { FieldConfig } from './field-config.schema';
import { FieldAuditLog } from './field-audit-log.schema';
import { TestCase } from '../test-cases/test-case.schema';

@Injectable()
export class FieldConfigService {
  constructor(
    @InjectModel(FieldConfig.name) private fieldModel: Model<FieldConfig>,
    @InjectModel(FieldAuditLog.name) private auditModel: Model<FieldAuditLog>,
    @InjectModel(TestCase.name) private testCaseModel: Model<TestCase>,
  ) {}

  async findAll(projectId: string, scriptId?: string) {
    const pid = new Types.ObjectId(projectId);

    // If a specific scriptId is requested, return only that script's fields
    if (scriptId) {
      const sid = new Types.ObjectId(scriptId);
      const fields = await this.fieldModel.find({ projectId: pid, scriptId: sid, isActive: true }).sort({ order: 1 }).lean();
      return { fields };
    }

    // Return ALL active fields for this project
    const fields = await this.fieldModel.find({ projectId: pid, isActive: true }).sort({ order: 1 }).lean();
    return { fields };
  }

  async create(dto: any, changedBy = 'system') {
    const count = await this.fieldModel.countDocuments({ projectId: new Types.ObjectId(dto.projectId), isActive: true, ...(dto.scriptId ? { scriptId: new Types.ObjectId(dto.scriptId) } : {}) });
    const created = await this.fieldModel.create({ ...dto, projectId: new Types.ObjectId(dto.projectId), scriptId: dto.scriptId ? new Types.ObjectId(dto.scriptId) : undefined, order: dto.order ?? count });
    await this.auditModel.create({ projectId: created.projectId, fieldConfigId: created._id, changeType: 'CREATE', changedBy, afterValue: created.toObject(), changedFields: Object.keys(dto) });
    // Sync to test cases
    await this.syncTestCaseSteps(dto.projectId, dto.scriptId);
    return created.toObject();
  }

  async update(id: string, dto: any, changedBy = 'system') {
    const before = await this.fieldModel.findById(id).lean();
    if (!before) throw new NotFoundException('Field not found');

    // Strip fields that should not be modified via update
    const { _id, __v, createdAt, updatedAt, changedBy: _, isActive, projectId, scriptId, ...safeDto } = dto;

    // Ensure isActive is never set to false via update — use DELETE endpoint for that
    const updatePayload = { ...safeDto, isActive: true };

    const updated = await this.fieldModel.findByIdAndUpdate(id, { $set: updatePayload }, { new: true }).lean();
    const changedFields = Object.keys(safeDto).filter((k) => JSON.stringify((before as any)[k]) !== JSON.stringify(safeDto[k]));
    if (changedFields.length) {
      await this.auditModel.create({ projectId: before.projectId, fieldConfigId: before._id, changeType: 'UPDATE', changedBy, beforeValue: before, afterValue: updated, changedFields });
    }
    // Sync to test cases — use scriptId from the field being updated
    await this.syncTestCaseSteps(before.projectId.toString(), (before as any).scriptId?.toString());
    return updated;
  }

  async remove(id: string, changedBy = 'system') {
    const before = await this.fieldModel.findById(id).lean();
    if (!before) throw new NotFoundException('Field not found');
    await this.fieldModel.findByIdAndUpdate(id, { isActive: false });
    await this.auditModel.create({ projectId: before.projectId, fieldConfigId: before._id, changeType: 'DELETE', changedBy, beforeValue: before, changedFields: ['isActive'] });
    // Sync to test cases — use scriptId from the field being removed
    await this.syncTestCaseSteps(before.projectId.toString(), (before as any).scriptId?.toString());
    return { message: 'Field deleted' };
  }

  async reorder(fieldIds: string[]) {
    await Promise.all(fieldIds.map((id, i) => this.fieldModel.findByIdAndUpdate(id, { order: i })));
    // Get projectId and scriptId from first field to sync
    if (fieldIds.length > 0) {
      const field = await this.fieldModel.findById(fieldIds[0]).lean();
      if (field) await this.syncTestCaseSteps(field.projectId.toString(), (field as any).scriptId?.toString());
    }
    return { message: 'Reordered' };
  }

  async getAuditLogs(projectId: string) {
    return this.auditModel.find({ projectId: new Types.ObjectId(projectId) }).sort({ createdAt: -1 }).limit(50).lean();
  }

  /**
   * List all recorded scripts for a project with their field counts.
   * Used by the Field Management UI to show a dropdown/list of available scripts.
   */
  async listScripts(projectId: string) {
    const pid = new Types.ObjectId(projectId);
    const testCases = await this.testCaseModel.find({
      projectId: pid,
      tags: 'field-config',
      isDeleted: { $ne: true },
    }).sort({ createdAt: -1 }).lean();

    const scripts = await Promise.all(testCases.map(async (tc: any) => {
      const fieldCount = await this.fieldModel.countDocuments({ projectId: pid, scriptId: tc._id, isActive: true });
      return {
        _id: tc._id,
        scriptName: tc.title,
        fieldCount: fieldCount || tc.steps?.length || 0,
        createdAt: tc.createdAt,
      };
    }));

    return { scripts, total: scripts.length };
  }

  /**
   * Called after recording stops - deduplicates actions and creates field configs.
   * Each recording session creates a NEW script (test case) so previous scripts are preserved.
   *
   * FIX (multi-step wizard forms): the old dedup logic used `selector|action|label`
   * as a global key, so clicking the SAME "Next" button on step 1, step 2, and
   * step 3 of a wizard produced the same key and every click after the first was
   * silently DROPPED. The replayed script then only advanced one screen and every
   * later field failed. New rule:
   *   - CONSECUTIVE duplicates (double-fired events for one physical action) are
   *     still merged / value-refined.
   *   - NON-consecutive repeats of click-type actions (Next / Save / Submit clicked
   *     again on a later screen) are REAL steps and are kept, each with its own
   *     XPath from the recording so replay can target the right button.
   *   - Non-consecutive repeats of value actions (select/fill/check) update the
   *     earlier step's value (unchanged behavior — re-picking a dropdown refines it).
   */
  async createFromRecordedActions(projectId: string, actions: { action: string; selector: string; xpath?: string; label: string; tag: string; value: string }[], scriptName?: string) {
    const pid = new Types.ObjectId(projectId);
    const seen = new Set<string>();
    const created: any[] = [];

    // Determine the next script number for this project
    const existingScriptCount = await this.testCaseModel.countDocuments({
      projectId: pid,
      tags: 'field-config',
      isDeleted: { $ne: true },
    });
    const nextScriptNum = existingScriptCount + 1;

    // Get project name for a better title
    let projectName = 'Project';
    try {
      const Project = this.testCaseModel.db.model('Project');
      const proj = await Project.findById(pid).lean();
      if (proj && (proj as any).name) projectName = (proj as any).name;
    } catch {}

    const resolvedScriptName = scriptName || `${projectName} - Script ${nextScriptNum}`;

    // Create the new test case FIRST so we have a scriptId to link field configs
    const testCase = await this.testCaseModel.create({
      projectId: pid,
      title: resolvedScriptName,
      description: `Recorded test script`,
      type: 'FUNCTIONAL',
      module: 'Recorded',
      priority: 'MEDIUM',
      isAutomated: true,
      steps: [],
      tags: ['recorded', 'field-config', 'auto-generated'],
    });

    const scriptId = testCase._id;
    let order = 0;

    // Collapse noisy widget cascades (e.g. Select2 searchable dropdowns) into a
    // single clean action before creating field configs.
    const normalizedActions = this.collapseSelect2Cascades(actions);

    // Track the created field per dedup key so repeated value-bearing actions on the
    // same element (e.g. a Select2 dropdown fired first with placeholder "Select",
    // then with the real choice "Delhi") UPDATE the value instead of being dropped.
    const fieldByKey = new Map<string, any>();

    // The key of the most recently processed action — used to distinguish
    // CONSECUTIVE duplicates (event double-fire) from later, intentional repeats
    // (wizard "Next" clicked on a subsequent screen).
    let lastKey = '';

    for (const act of normalizedActions) {
      if (!act.selector) continue;
      const baseKey = `${act.selector}|${act.action}|${act.label}`;

      const actionType = this.mapActionType(act.action, act.tag);
      const isValueAction = ['select', 'fill', 'check'].includes(actionType);
      // Click-type actions can legitimately repeat across wizard screens
      const isRepeatableAction = ['click', 'dblclick', 'press'].includes(actionType);

      let createKey = baseKey;
      let shouldCreate = true;

      if (seen.has(baseKey)) {
        const isConsecutive = baseKey === lastKey;

        if (isValueAction) {
          // Value refinement (placeholder → real choice), consecutive or not:
          // update the earlier step's value instead of creating a duplicate.
          const existing = fieldByKey.get(baseKey);
          if (existing && this.isMeaningfulValue(act.value)) {
            existing.defaultValue = act.value;
            await this.fieldModel.updateOne(
              { _id: existing._id },
              { $set: { defaultValue: act.value } },
            );
          }
          shouldCreate = false;
        } else if (isRepeatableAction && !isConsecutive) {
          // WIZARD FIX: same button clicked again on a LATER screen — this is a
          // real, separate step. Give it an occurrence-suffixed key so it isn't
          // swallowed, and keep its own XPath (indexed → points at the right
          // step panel's button even when the CSS selector matches all of them).
          let occ = 2;
          while (seen.has(`${baseKey}#${occ}`)) occ++;
          createKey = `${baseKey}#${occ}`;
          seen.add(createKey);
        } else {
          // Consecutive duplicate (double-fired click/hover/focus on one physical
          // action) or a non-repeatable action type — drop it.
          shouldCreate = false;
        }
      } else {
        seen.add(baseKey);
      }

      lastKey = baseKey;
      if (!shouldCreate) continue;

      const section = this.classifySection(act);
      const inputType = this.mapInputType(act.tag, act.action);

      const field = await this.fieldModel.create({
        projectId: pid,
        scriptId,
        fieldName: act.label || act.selector.replace(/[#\[\]="]/g, ''),
        label: act.label || act.selector,
        section,
        scriptName: resolvedScriptName,
        selector: act.selector,
        xpath: act.xpath || '',
        actionType,
        inputType,
        defaultValue: act.value || '',
        order: order++,
        isActive: true,
      });
      created.push(field);
      // Value-refinement lookups always use the base key (first occurrence wins
      // for value updates; repeats of clicks don't need refinement).
      if (!fieldByKey.has(baseKey)) fieldByKey.set(baseKey, field);
    }

    // Now update the test case with the actual steps
    const steps = created.map((f, i) => ({
      step: String(i + 1),
      action: `${f.actionType}: ${f.label}`,
      expected: `Field ${f.label} processed successfully`,
      selector: f.selector,
    }));

    await this.testCaseModel.findByIdAndUpdate(scriptId, {
      $set: {
        steps,
        description: `Recorded test script with ${steps.length} steps`,
      },
    });

    return { fieldCount: created.length, fields: created, scriptId, scriptName: resolvedScriptName };
  }

  /**
   * Sync field config changes to the corresponding test case(s) in testCases collection.
   * Supports multiple scripts per project via scriptId linkage.
   * Also stamps the scriptName on field configs so all sections show the same name.
   */
  private async syncTestCaseSteps(projectId: string, scriptId?: string) {
    const pid = new Types.ObjectId(projectId);

    if (scriptId) {
      // Sync a specific script
      await this.syncSingleScript(pid, new Types.ObjectId(scriptId));
      return;
    }

    // Sync ALL scripts for this project
    const testCases = await this.testCaseModel.find({
      projectId: pid,
      tags: 'field-config',
      isDeleted: { $ne: true },
    }).lean();

    for (const tc of testCases) {
      await this.syncSingleScript(pid, tc._id as Types.ObjectId);
    }

    // Also handle legacy field configs without scriptId
    const orphanFields = await this.fieldModel
      .find({ projectId: pid, isActive: true, scriptId: { $exists: false } })
      .sort({ order: 1 })
      .lean();

    if (orphanFields.length > 0 && testCases.length === 0) {
      // No test case exists yet — create one for legacy fields
      const steps = orphanFields.map((f, i) => ({
        step: String(i + 1),
        action: `${f.actionType}: ${f.label}`,
        expected: f.assertType ? `Assert ${f.assertType}: ${f.expectedValue}` : `Field ${f.label} processed successfully`,
        selector: f.selector,
      }));

      const testCase = await this.testCaseModel.create({
        projectId: pid,
        title: `Script 1`,
        description: `Recorded test script with ${steps.length} steps`,
        type: 'FUNCTIONAL',
        module: 'Recorded',
        priority: 'MEDIUM',
        isAutomated: true,
        steps,
        tags: ['recorded', 'field-config', 'auto-generated'],
      });

      // Link the orphan fields to this new test case
      await this.fieldModel.updateMany(
        { projectId: pid, isActive: true, scriptId: { $exists: false } },
        { $set: { scriptId: testCase._id, scriptName: testCase.title } },
      );
    }
  }

  private async syncSingleScript(pid: Types.ObjectId, scriptId: Types.ObjectId) {
    const fieldConfigs = await this.fieldModel
      .find({ projectId: pid, scriptId, isActive: true })
      .sort({ order: 1 })
      .lean();

    if (fieldConfigs.length === 0) return;

    const steps = fieldConfigs.map((f, i) => ({
      step: String(i + 1),
      action: `${f.actionType}: ${f.label}`,
      expected: f.assertType ? `Assert ${f.assertType}: ${f.expectedValue}` : `Field ${f.label} processed successfully`,
      selector: f.selector,
    }));

    const testCase = await this.testCaseModel.findById(scriptId);
    if (testCase) {
      await this.testCaseModel.findByIdAndUpdate(scriptId, {
        $set: {
          steps,
          description: `Recorded test script with ${steps.length} steps`,
        },
      });

      // Keep scriptName on field configs in sync with the test case title
      await this.fieldModel.updateMany(
        { projectId: pid, scriptId, isActive: true, scriptName: { $ne: testCase.title } },
        { $set: { scriptName: testCase.title } },
      );
    }
  }

  /**
   * Detects Select2 / searchable-dropdown interaction cascades in a recorded action
   * stream and replaces them with a single `select` action targeting the real
   * underlying native <select> element.
   *
   * Select2 markup pattern:
   *   - The visible box has id/selector like `#select2-<selectId>-container`
   *     (or class `.select2-selection`, `.select2-container`).
   *   - Opening it reveals a search box (`.select2-search__field`,
   *     `[aria-label="Search"]`) and a results list (`.select2-results__option`,
   *     `li` inside `.select2-results`).
   * The real <select> is derivable from the container id: `select2-<X>-container` → `#<X>`.
   *
   * We scan for a container click, then consume any subsequent search/hover/results
   * actions, and emit one `select` action whose defaultValue is the chosen option text.
   */
  private collapseSelect2Cascades(
    actions: { action: string; selector: string; xpath?: string; label: string; tag: string; value: string }[],
  ) {
    const isSelect2Container = (s: string) =>
      /select2-[\w-]+-container/i.test(s) ||
      /\.select2(-selection|-container)?\b/i.test(s) ||
      /select2/i.test(s);

    const isSelect2Search = (a: { selector: string; label: string }) =>
      /select2-search|select2-search__field/i.test(a.selector) ||
      /aria-label="?search"?/i.test(a.selector) ||
      (a.label || '').trim().toLowerCase() === 'search';

    const isSelect2Result = (s: string) =>
      /select2-results__option|select2-results\b/i.test(s);

    // Recover the native <select> selector from a Select2 container selector.
    const nativeSelectFrom = (s: string): string | null => {
      const m = s.match(/select2-([\w-]+?)-container/i);
      if (m && m[1]) return `#${m[1]}`;
      return null;
    };

    // Selectors that reference transient widget internals (search boxes, result/option
    // lists, calendar cells). These are never replayable on their own and must not
    // become steps — the native <select>/<input> change action covers the real intent.
    // Also drops bootstrap-select artifacts from legacy recordings: the live-search
    // input ([aria-label="Search"] / .bs-searchbox), toggle button (.dropdown-toggle),
    // option anchors (a.dropdown-item / li a in the menu), and the wrapper itself.
    const isTransientInternalSelector = (s: string, label: string) =>
      isSelect2Search({ selector: s, label }) ||
      isSelect2Result(s) ||
      /\.bs-searchbox|\.dropdown-menu(\.show)?\b/i.test(s) ||
      /bootstrap-select/i.test(s) ||
      /(^|\s|\.)dropdown-toggle\b/i.test(s) ||
      /\.dropdown-item\b/i.test(s) ||
      /aria-label="?search"?/i.test(s) ||
      /(datepicker|daterangepicker|flatpickr-calendar|ui-datepicker)/i.test(s);

    const result: typeof actions = [];

    for (let i = 0; i < actions.length; i++) {
      const act = actions[i];

      // Drop stray widget-internal actions outright (from legacy recordings that
      // captured them before internal-suppression was added to the recorder).
      // Never drop the native <select> change itself — that is the real action.
      if (
        act.action !== 'select' &&
        act.tag !== 'select' &&
        isTransientInternalSelector(act.selector || '', act.label || '')
      ) {
        continue;
      }

      // Start of a potential Select2 cascade: a click/hover on the container
      if (
        (act.action === 'click' || act.action === 'hover' || act.action === 'focus') &&
        isSelect2Container(act.selector)
      ) {
        // Look ahead to find the chosen option (last results click/hover in the run)
        let j = i + 1;
        let chosenText = '';
        let consumedAny = false;
        while (j < actions.length) {
          const next = actions[j];
          if (
            isSelect2Container(next.selector) &&
            next.action === 'click' &&
            !isSelect2Result(next.selector)
          ) {
            // Another container click that isn't a result — could be a re-open; stop here
            if (consumedAny) break;
          }
          if (isSelect2Search(next) || isSelect2Result(next.selector) || isSelect2Container(next.selector)) {
            // The option text lives on the results element the user hovered/clicked
            if (isSelect2Result(next.selector) && (next.label || next.value)) {
              chosenText = (next.label || next.value).trim();
            }
            consumedAny = true;
            j++;
            continue;
          }
          break;
        }

        const nativeSel = nativeSelectFrom(act.selector);
        if (consumedAny && nativeSel) {
          result.push({
            action: 'select',
            selector: nativeSel,
            xpath: '',
            label: act.label || nativeSel.replace('#', ''),
            tag: 'select',
            value: chosenText,
          });
          i = j - 1; // skip the consumed cascade actions
          continue;
        }
        // Not a recognizable cascade — fall through and keep the original action
      }

      result.push(act);
    }

    return result;
  }

  /**
   * A recorded value is "meaningful" if it represents a real user choice rather than a
   * dropdown placeholder or empty string. Select2/native selects often fire an initial
   * change with the placeholder ("Select", "-- Select --", "Choose...") before the real
   * option is picked; we don't want the placeholder to win over the real value.
   */
  private isMeaningfulValue(value: string): boolean {
    if (!value) return false;
    const v = value.trim().toLowerCase();
    if (!v) return false;
    const placeholders = [
      'select',
      '-- select --',
      '--select--',
      'select...',
      'please select',
      'choose',
      'choose...',
      'none',
      'nothing selected',
    ];
    return !placeholders.includes(v);
  }

  private classifySection(act: any): string {
    const label = (act.label || '').toLowerCase();
    if (label.includes('login') || label.includes('password') || label.includes('otp')) return 'Authentication';
    if (label.includes('name') || label.includes('email') || label.includes('phone') || label.includes('address')) return 'Personal Details';
    if (label.includes('policy') || label.includes('premium') || label.includes('plan')) return 'Policy Details';
    if (label.includes('nominee') || label.includes('beneficiary')) return 'Nominee';
    if (label.includes('bank') || label.includes('ifsc') || label.includes('account')) return 'Bank Details';
    if (label.includes('submit') || label.includes('next') || label.includes('save')) return 'Actions';
    return 'General';
  }

  private mapActionType(action: string, tag: string): string {
    if (action === 'hover') return 'hover';
    if (action === 'dblclick') return 'dblclick';
    if (action === 'press') return 'press';
    if (action === 'scroll') return 'scroll';
    if (action === 'focus') return 'click'; // focus maps to click for replay
    if (action === 'rightclick') return 'click'; // rightclick maps to click for replay
    if (action === 'click' || tag === 'button' || tag === 'a') return 'click';
    if (action === 'select' || tag === 'select') return 'select';
    if (action === 'check') return 'check';
    return 'fill';
  }

  private mapInputType(tag: string, action: string): string {
    if (tag === 'select') return 'select';
    if (action === 'check') return 'checkbox';
    return 'text';
  }
}
