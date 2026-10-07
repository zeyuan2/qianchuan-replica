// Pure policy: no network, scheduler, credentials, or account writes.
// Live execution must supply verified plan state and persist confirmed outcomes.
export const HOUR = 3600000;
export const DAY = 24 * HOUR;
export const RULES = Object.freeze({
  version: '2026-10-07.1', timezone: 'Asia/Shanghai',
  threshold: 0.8, stableRoi: 3.1, roiStep: 0.2,
  coldBudget: 300, coldStep: 300, stableBudget: 1000,
  stableStep: 1000, maxBudget: 10000,
  roiWeight: 0.6, volumeWeight: 0.4,
  upperScore: 5, lowerScore: -5, boostBudget: 100, boostHours: 6,
});
const finite = value => typeof value === 'number' && Number.isFinite(value);
const cents = value => Math.round(value * 100);
const round = value => Math.round(value * 100) / 100;
export const localDay = time => new Date(time + 8 * HOUR).toISOString().slice(0, 10);
export const dayStart = time => Math.floor((time + 8 * HOUR) / DAY) * DAY - 8 * HOUR;
const block = reason => ({kind: 'blocked', reason, notify: true});
const wait = reason => ({kind: 'wait', reason});

export function validateEnrollment(enrollment) {
  if (enrollment?.version !== RULES.version || !/^\d{10,25}$/.test(enrollment.accountId || '') ||
      !Array.isArray(enrollment.planIds) || enrollment.planIds.length === 0 ||
      enrollment.planIds.some(id => typeof id !== 'string' || !/^\d{10,25}$/.test(id)) ||
      new Set(enrollment.planIds).size !== enrollment.planIds.length) {
    throw new Error('AUTOMATION_ENROLLMENT_INVALID');
  }
  return enrollment;
}

export function roiIntervalReady(lastChangedAt, now) {
  return finite(lastChangedAt) && lastChangedAt > 0 && lastChangedAt <= now && now - lastChangedAt > HOUR;
}

export function spendReached(budget, spend) {
  return finite(budget) && budget > 0 && finite(spend) && spend >= 0 &&
    cents(spend) * 5 >= cents(budget) * 4;
}

// Windows must be exact [start,end) intervals. Hour buckets which straddle an
// edit cannot be prorated or silently substituted for the requested interval.
export function windowTotals(window) {
  if (!window || window.complete !== true || !finite(window.start) ||
      !finite(window.end) || window.end - window.start !== DAY ||
      typeof window.accountId !== 'string' || typeof window.planId !== 'string' ||
      typeof window.metricDefinition !== 'string' || !window.metricDefinition ||
      !finite(window.revenue) || window.revenue < 0 ||
      !finite(window.roiCost) || window.roiCost <= 0 ||
      !finite(window.basicSpend) || window.basicSpend < 0) {
    throw new Error('AUTOMATION_WINDOW_INVALID');
  }
  return {roi: window.revenue / window.roiCost, spend: window.basicSpend};
}

export function evaluateWindows(before, after, now) {
  const a = windowTotals(before), b = windowTotals(after);
  if (before.accountId !== after.accountId || before.planId !== after.planId ||
      before.metricDefinition !== after.metricDefinition || before.end !== after.start ||
      after.end > now || before.settingsStable !== true || after.settingsStable !== true) {
    throw new Error('AUTOMATION_WINDOWS_NOT_COMPARABLE');
  }
  // Zero revenue after spending is a valid poor outcome, never missing data.
  if (b.roi < RULES.stableRoi) return {decision: 'rollback', reason: 'ROI_BELOW_FLOOR', before: a, after: b, score: null};
  if (a.roi <= 0 || a.spend <= 0) throw new Error('AUTOMATION_BASELINE_ZERO');
  const roiChange = b.roi / a.roi - 1, volumeChange = b.spend / a.spend - 1;
  const score = Math.round((60 * roiChange + 40 * volumeChange) * 1e10) / 1e10;
  return {
    decision: score >= RULES.upperScore ? 'explore' : score <= RULES.lowerScore ? 'rollback' : 'hold',
    reason: 'WEIGHTED_COMPARISON', score, roiChange, volumeChange, before: a, after: b,
  };
}

function guards(enrollment, plan, state, now) {
  validateEnrollment(enrollment);
  if (!plan || !enrollment.planIds.includes(plan.id)) return block('PLAN_NOT_ENROLLED');
  if (plan.accountId !== enrollment.accountId) return block('ACCOUNT_MISMATCH');
  if (plan.source !== 'live' || plan.verified !== true || !finite(plan.readAt) ||
      plan.readAt > now || now - plan.readAt > 5 * 60000) return block('LIVE_STATE_NOT_FRESH');
  if (state?.pendingWrite || state?.uncertainWrite) return block('PREVIOUS_WRITE_UNRESOLVED');
  if (plan.active !== true || plan.auditPassed !== true) return block('PLAN_PAUSED_OR_UNAPPROVED');
  if (!finite(plan.roi) || plan.roi <= 0 || !finite(plan.budget) || plan.budget < 300 ||
      !finite(plan.basicSpend) || plan.basicSpend < 0 || plan.spendDay !== localDay(now)) return block('PLAN_METRICS_INVALID');
  return null;
}

// The caller schedules explicit events. A missed 00:00 / 05:00 / 17:00 event
// is not replayed as an immediate startup action.
export function decide(enrollment, plan, state = {}, now = Date.now(), event = 'capture') {
  const denied = guards(enrollment, plan, state, now);
  if (denied) return denied;
  const day = localDay(now), key = `${plan.id}:${day}:${event}`;
  if (event !== 'capture' && state.completedEvents?.includes(key)) return wait('EVENT_ALREADY_HANDLED');
  if (event === 'midnight') {
    if (plan.roi >= RULES.stableRoi || plan.budget === RULES.coldBudget) return wait('NO_RESET_NEEDED');
    return {kind: 'budget', budget: RULES.coldBudget, reason: 'COLD_DAILY_RESET', eventKey: key};
  }
  if (event === 'boost-morning' || event === 'boost-evening') {
    if (!finite(plan.createdAt) || plan.createdAt <= 0 || plan.createdAt > now) return block('CREATION_TIME_UNKNOWN');
    if (plan.roi >= RULES.stableRoi || now - plan.createdAt >= 3 * DAY || state.boostPermanentlyStopped === true) return wait('BOOST_STOP_CONDITION');
    if (event === 'boost-morning' && localDay(plan.createdAt) !== localDay(now - DAY)) return wait('NOT_CREATED_YESTERDAY');
    if (plan.boostState !== 'eligible') return block('BOOST_ACTIVE_OR_UNKNOWN');
    if (state.boostHistoryVerified !== true) return block('BOOST_HISTORY_UNKNOWN');
    return {kind: 'boost', budget: RULES.boostBudget, duration: RULES.boostHours, eventKey: key};
  }
  if (event !== 'capture') return block('UNKNOWN_EVENT');
  const roiReady = roiIntervalReady(state.lastRoiChangedAt, now);
  if (plan.roi < RULES.stableRoi) {
    if (!finite(plan.approvedAt) || plan.approvedAt <= 0 || plan.approvedAt > now) return block('APPROVAL_TIME_UNKNOWN');
    if (now < dayStart(plan.approvedAt) + DAY) return wait('BEFORE_FIRST_APPROVED_MIDNIGHT');
    if (!spendReached(plan.budget, plan.basicSpend)) return wait('SPEND_BELOW_THRESHOLD');
    if (!roiReady) return wait('ROI_INTERVAL_NOT_READY');
    const roi = Math.min(RULES.stableRoi, round(plan.roi + RULES.roiStep));
    const budget = roi === RULES.stableRoi ? RULES.stableBudget : Math.min(RULES.maxBudget, plan.budget + RULES.coldStep);
    return {kind: 'roi-budget', roi, budget, reason: roi === RULES.stableRoi ? 'ENTER_STABLE' : 'COLD_ADVANCE'};
  }
  // Evaluation must be tied to this exact current ROI epoch, not an old score.
  const observation = state.observation;
  if (!observation || observation.roi !== plan.roi || observation.roiChangedAt !== state.lastRoiChangedAt ||
      observation.start < state.lastRoiChangedAt ||
      !finite(observation.start) || !finite(observation.end) || observation.end - observation.start !== DAY) {
    return block('STABLE_OBSERVATION_NOT_INITIALIZED');
  }
  if (now >= observation.end && !observation.evaluation) return wait('WAITING_FOR_COMPLETE_24H_DATA');
  const evaluation = observation.evaluation;
  if (evaluation && now < observation.end) return block('PREMATURE_EVALUATION');
  if (evaluation?.decision === 'rollback') {
    if (!roiReady) return wait('ROI_INTERVAL_NOT_READY');
    const good = state.goodSettings?.filter(v => v.complete === true && finite(v.at) && v.at < observation.start &&
      finite(v.roi) && v.roi >= RULES.stableRoi && v.roi !== plan.roi &&
      finite(v.actualRoi) && v.actualRoi >= RULES.stableRoi).sort((a,b) => b.at - a.at)[0];
    if (!good) return block('NO_VERIFIED_ROLLBACK_TARGET');
    return {kind: 'roi', roi: good.roi, reason: 'STABLE_ROLLBACK', notify: true};
  }
  if (evaluation && !['explore', 'hold'].includes(evaluation.decision)) return block('INVALID_EVALUATION');
  if (!spendReached(plan.budget, plan.basicSpend)) return wait('SPEND_BELOW_THRESHOLD');
  if (plan.budget >= RULES.maxBudget) return wait('BUDGET_CAP_REACHED');
  const budget = Math.min(RULES.maxBudget, plan.budget + RULES.stableStep);
  if (evaluation?.decision === 'explore') {
    if (!roiReady) return wait('ROI_INTERVAL_NOT_READY');
    return {kind: 'roi-budget', roi: round(plan.roi + RULES.roiStep), budget, reason: 'STABLE_EXPLORE'};
  }
  return {kind: 'budget', budget, reason: evaluation?.decision === 'hold' ? 'STABLE_HOLD' : 'OBSERVATION_BUDGET_ONLY'};
}

// Invoke only after read-after-write confirms the change. A request or timeout
// is not a confirmed change and must never advance automation state.
export function confirmedChange(state, {before, after, at, source, reason}) {
  if (!finite(at) || !['manual','automation'].includes(source) || before.id !== after.id ||
      before.accountId !== after.accountId || !finite(before.roi) || !finite(after.roi) ||
      !finite(before.budget) || !finite(after.budget)) throw new Error('CONFIRMED_CHANGE_INVALID');
  const next = structuredClone(state), day = localDay(at);
  // Entering stable delivery also permanently ends scheduled cold-start boosts.
  if (after.roi >= RULES.stableRoi) next.boostPermanentlyStopped = true;
  next.budgetChanges = [...(next.budgetChanges || []), {at, before:before.budget, after:after.budget, source}].slice(-200);
  if (before.roi !== after.roi) {
    next.lastRoiChangedAt = at;
    next.observation = after.roi >= RULES.stableRoi ? {start:at,end:at+DAY,roiChangedAt:at,roi:after.roi,evaluation:null} : null;
  }
  // Track the factual same-day 300->600->900 chain, not a cross-day stage.
  if (reason === 'COLD_DAILY_RESET') next.coldBudgetChain = {day, current:300};
  if (reason === 'COLD_ADVANCE' && source === 'automation') {
    if (before.budget === 300 && after.budget === 600) next.coldBudgetChain = {day,current:600};
    else if (next.coldBudgetChain?.day === day && next.coldBudgetChain.current === 600 &&
             before.budget === 600 && after.budget === 900) {
      next.coldBudgetChain.current = 900;
      next.boostPermanentlyStopped = true;
    } else next.coldBudgetChain = null;
  } else if (before.budget !== after.budget && reason !== 'COLD_DAILY_RESET') next.coldBudgetChain = null;
  return next;
}
