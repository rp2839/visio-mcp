import type { Diagnostic, DiagramDocument, EntityChange, Operation } from '../model/types';
import { err, ok, PlanError, type Result } from '../model/result';
import { checkInvariants, validateElementSchema, validateOperations } from '../model/validate';
import { Draft, type DraftContext } from './draft';
import { computeChanges } from './diff';
import {
  planAddLayer, planAddPage, planAssignLayer, planCreate, planDelete, planDeleteAsset, planDeleteLayer, planDeletePage,
  planDuplicate, planDuplicatePage, planRegisterAsset, planReorderPage, planReplaceAssetGlobal, planSet, planSetAsset,
  planSetLayer, planSetPage,
} from './structure';
import { planMove, planResize, planRotate } from './geometry';
import { planGroup, planUngroup } from './groups';
import { planAlign, planDistribute, planSetGap, planZOrder } from './arrange';

export type PlannedTransaction = {
  candidate: DiagramDocument;
  changes: EntityChange[];
  aliases: Record<string, string>;
  warnings: Diagnostic[];
};

export const MAX_OPERATIONS = 1000;

function apply(d: Draft, op: Operation) {
  switch (op.op) {
    case 'create': return planCreate(d, op);
    case 'set': return planSet(d, op);
    case 'move': return planMove(d, op);
    case 'resize': return planResize(d, op);
    case 'rotate': return planRotate(d, op);
    case 'delete': return planDelete(d, op);
    case 'duplicate': return planDuplicate(d, op);
    case 'group': return planGroup(d, op);
    case 'ungroup': return planUngroup(d, op);
    case 'align': return planAlign(d, op);
    case 'distribute': return planDistribute(d, op);
    case 'setGap': return planSetGap(d, op);
    case 'zorder': return planZOrder(d, op);
    case 'addPage': return planAddPage(d, op);
    case 'setPage': return planSetPage(d, op);
    case 'reorderPage': return planReorderPage(d, op);
    case 'duplicatePage': return planDuplicatePage(d, op);
    case 'deletePage': return planDeletePage(d, op);
    case 'addLayer': return planAddLayer(d, op);
    case 'setLayer': return planSetLayer(d, op);
    case 'assignLayer': return planAssignLayer(d, op);
    case 'deleteLayer': return planDeleteLayer(d, op);
    case 'registerAsset': return planRegisterAsset(d, op);
    case 'setAsset': return planSetAsset(d, op);
    case 'replaceAssetGlobal': return planReplaceAssetGlobal(d, op);
    case 'deleteAsset': return planDeleteAsset(d, op);
  }
}

/**
 * Pure planner: stages every operation on one candidate (earlier creates visible to later
 * operations), recomputes derived group bounds, validates the whole final state and
 * returns the resolved diff. Never touches the committed document.
 */
export function planOperations(doc: DiagramDocument, operations: unknown, ctx: DraftContext): Result<PlannedTransaction> {
  if (Array.isArray(operations) && operations.length > MAX_OPERATIONS)
    return err('limit_exceeded', `batch has ${operations.length} operations; the limit is ${MAX_OPERATIONS}`, undefined, 'not_applied');
  const shape = validateOperations(operations);
  if (!shape.ok) return { ok: false, error: { ...shape.error, outcome: 'not_applied' } };
  const ops = shape.value;
  let d: Draft;
  try {
    d = new Draft(doc, ctx);
  } catch (e) {
    return e instanceof PlanError ? e.toResult() : err('internal_error', String(e));
  }
  for (let i = 0; i < ops.length; i++) {
    try {
      apply(d, ops[i]);
    } catch (e) {
      if (e instanceof PlanError) return err(e.code, `operation ${i} (${ops[i].op}): ${e.message}`, { ...e.details, operationIndex: i }, 'not_applied');
      return err('internal_error', `operation ${i} (${ops[i].op}) failed: ${(e as Error).message}`, { operationIndex: i }, 'not_applied');
    }
  }
  d.normaliseGroups();
  d.sortElements();
  const problems = checkInvariants(d.doc);
  if (problems.length) {
    const dep = problems.filter((p) => p.code === 'dependency_conflict');
    if (dep.length) return err('dependency_conflict', dep[0].message, { elementIds: [...new Set(dep.map((p) => p.elementId))], problems: dep.slice(0, 20) }, 'not_applied');
    return err(problems[0].code, problems[0].message, { problems: problems.slice(0, 20) }, 'not_applied');
  }
  const changes = computeChanges(doc, d.doc, d.touched);
  for (const c of changes) {
    if (c.entity !== 'element' || c.after === null) continue;
    const v = validateElementSchema(c.after);
    if (!v.ok) return err('invalid_request', `element ${c.id}: ${v.error.message}`, { elementId: c.id }, 'not_applied');
  }
  return ok({ candidate: d.doc, changes, aliases: d.createdAliases, warnings: d.warnings });
}
