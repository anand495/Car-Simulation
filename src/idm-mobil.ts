/**
 * IDM (Intelligent Driver Model) and MOBIL (Minimizing Overall Braking
 * Induced by Lane changes) Implementation
 *
 * References:
 * - IDM: Treiber, Hennecke & Helbing (2000) "Congested traffic states in
 *   empirical observations and microscopic simulations"
 * - MOBIL: Kesting, Treiber & Helbing (2007) "General lane-changing model
 *   MOBIL for car-following models"
 */

import { IDM, MOBIL, CAR_LENGTH, IDMParams } from './types.js';

// ============================================================================
// IDM - Intelligent Driver Model
// ============================================================================

/**
 * IDM acceleration calculation
 *
 * The IDM computes acceleration as:
 *   a = a_max * [1 - (v/v0)^δ - (s*(v,Δv)/s)²]
 *
 * where:
 *   v     = current speed
 *   v0    = desired speed
 *   s     = actual gap to leader
 *   s*    = desired gap (dynamic, depends on speed and approach rate)
 *   Δv    = approach rate (v - v_leader)
 *   δ     = acceleration exponent (typically 4)
 *
 * The desired gap s* is:
 *   s* = s0 + max(0, v*T + v*Δv/(2*sqrt(a*b)))
 *
 * where:
 *   s0 = minimum gap (jam distance)
 *   T  = desired time headway
 *   a  = max acceleration
 *   b  = comfortable deceleration
 */
export function idmAcceleration(
  speed: number,           // current speed (m/s)
  desiredSpeed: number,    // desired/target speed (m/s)
  gap: number,             // gap to vehicle ahead (m)
  leaderSpeed: number,     // speed of vehicle ahead (m/s)
  params: IDMParams = IDM
): number {
  const { T, s0, a, b, delta } = params;

  // Approach rate (positive when closing in)
  const deltaV = speed - leaderSpeed;

  // Desired dynamic gap
  // s* = s0 + max(0, v*T + v*Δv/(2*sqrt(a*b)))
  const interaction = (speed * deltaV) / (2 * Math.sqrt(a * b));
  const sStar = s0 + Math.max(0, speed * T + interaction);

  // Free road term: accelerate toward desired speed
  // [1 - (v/v0)^δ]
  const freeRoadTerm = desiredSpeed > 0
    ? 1 - Math.pow(speed / desiredSpeed, delta)
    : 0;

  // Interaction term: decelerate based on gap
  // (s*/s)²
  const interactionTerm = gap > 0
    ? Math.pow(sStar / gap, 2)
    : 1; // If gap <= 0, maximum braking

  // IDM acceleration
  const acceleration = a * (freeRoadTerm - interactionTerm);

  return acceleration;
}

/**
 * Simplified IDM for computing target speed given gap
 * Returns the speed that would result in zero acceleration (equilibrium)
 */
export function idmEquilibriumSpeed(
  gap: number,
  leaderSpeed: number,
  desiredSpeed: number,
  params: IDMParams = IDM
): number {
  const { T, s0 } = params;

  // No leader or very far away - drive at desired speed
  if (gap >= 100) {
    return desiredSpeed;
  }

  // At equilibrium, the gap equals the desired gap at current speed
  // s = s0 + v*T (simplified, ignoring approach rate term)
  // Solving for v: v = (s - s0) / T

  if (gap <= s0) {
    return 0; // Too close, stop
  }

  // Equilibrium speed based on gap
  const gapBasedSpeed = (gap - s0) / T;

  // Also consider leader's speed - don't go faster than leader + reasonable margin
  // This prevents tailgating a slow leader
  const safeSpeed = Math.min(gapBasedSpeed, leaderSpeed + 2);

  // Cap at desired speed
  return Math.min(safeSpeed, desiredSpeed);
}

// ============================================================================
// MOBIL - Lane Change Model
// ============================================================================

/**
 * MOBIL incentive criterion for lane changing
 *
 * A lane change is advantageous if:
 *   ã_c - a_c > p * (a_n + ã_n - a_o - ã_o) + a_threshold + a_bias
 *
 * where:
 *   a_c   = current acceleration (in current lane)
 *   ã_c   = new acceleration (after lane change)
 *   a_n   = acceleration of new follower (before lane change)
 *   ã_n   = acceleration of new follower (after lane change)
 *   a_o   = acceleration of old follower (before lane change)
 *   ã_o   = acceleration of old follower (after lane change)
 *   p     = politeness factor
 *   a_threshold = minimum improvement threshold
 *   a_bias = directional bias (e.g., keep right)
 *
 * Safety criterion:
 *   ã_n >= -b_safe (new follower must not brake too hard)
 */

export interface LaneChangeContext {
  // Current vehicle state
  mySpeed: number;
  myDesiredSpeed: number;

  // Current lane situation
  currentGap: number;           // gap to leader in current lane
  currentLeaderSpeed: number;   // speed of leader in current lane

  // Target lane situation
  targetGap: number;            // gap to leader in target lane
  targetLeaderSpeed: number;    // speed of leader in target lane
  targetFollowerGap: number;    // gap from new follower to me (after change)
  targetFollowerSpeed: number;  // speed of new follower

  // My old follower situation (in current lane)
  oldFollowerGap: number;       // current gap from old follower to me
  oldFollowerSpeed: number;     // speed of old follower
  oldFollowerNewGap: number;    // gap from old follower to current leader (after I leave)
  oldFollowerNewLeaderSpeed: number; // speed of the car that will be ahead of old follower

  // Direction bias (positive = changing to right/lower lane number)
  isTowardPreferredLane: boolean;
}

/**
 * Evaluate if a lane change is beneficial according to MOBIL
 * Returns: { shouldChange: boolean, incentive: number }
 */
export function mobilLaneChangeDecision(
  context: LaneChangeContext,
  params: typeof MOBIL = MOBIL
): { shouldChange: boolean; incentive: number; isSafe: boolean } {
  const { p, athreshold, bsafe, abias } = params;

  // Calculate accelerations using IDM

  // My acceleration in current lane
  const a_c = idmAcceleration(
    context.mySpeed,
    context.myDesiredSpeed,
    context.currentGap,
    context.currentLeaderSpeed
  );

  // My acceleration in target lane (after change)
  const a_c_new = idmAcceleration(
    context.mySpeed,
    context.myDesiredSpeed,
    context.targetGap,
    context.targetLeaderSpeed
  );

  // New follower's acceleration before I arrive
  const a_n = idmAcceleration(
    context.targetFollowerSpeed,
    context.myDesiredSpeed, // Assume same desired speed
    context.targetFollowerGap + context.targetGap, // Current gap to their leader
    context.targetLeaderSpeed
  );

  // New follower's acceleration after I cut in
  const a_n_new = idmAcceleration(
    context.targetFollowerSpeed,
    context.myDesiredSpeed,
    context.targetFollowerGap, // Now following me
    context.mySpeed
  );

  // Old follower's acceleration before I leave
  const a_o = idmAcceleration(
    context.oldFollowerSpeed,
    context.myDesiredSpeed,
    context.oldFollowerGap,
    context.mySpeed
  );

  // Old follower's acceleration after I leave
  const a_o_new = idmAcceleration(
    context.oldFollowerSpeed,
    context.myDesiredSpeed,
    context.oldFollowerNewGap,
    context.oldFollowerNewLeaderSpeed
  );

  // Safety criterion: new follower must not brake too hard
  const isSafe = a_n_new >= -bsafe;

  // Incentive criterion
  // My gain
  const myGain = a_c_new - a_c;

  // Politeness: consider impact on others
  // New follower disadvantage + Old follower advantage
  const othersImpact = (a_n_new - a_n) + (a_o_new - a_o);

  // Bias for preferred lane (e.g., right lane in US)
  const bias = context.isTowardPreferredLane ? abias : -abias;

  // Total incentive
  const incentive = myGain - p * othersImpact + bias;

  // Decision: change if safe and incentive exceeds threshold
  const shouldChange = isSafe && incentive > athreshold;

  return { shouldChange, incentive, isSafe };
}

/**
 * Simplified MOBIL check when we just need to verify safety
 * Used when lane change is mandatory (e.g., need to reach exit)
 */
export function mobilSafetyCheck(
  mySpeed: number,
  targetFollowerGap: number,
  targetFollowerSpeed: number,
  params: typeof MOBIL = MOBIL
): boolean {
  const { bsafe } = params;

  // Calculate what acceleration the new follower would need
  const followerAccel = idmAcceleration(
    targetFollowerSpeed,
    targetFollowerSpeed, // Maintain current speed as desired
    targetFollowerGap,
    mySpeed // I become their leader
  );

  // Safe if follower doesn't need to brake harder than bsafe
  return followerAccel >= -bsafe;
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Compute safe following gap for a given speed
 */
export function safeFollowingGap(speed: number, params: typeof IDM = IDM): number {
  const { s0, T } = params;
  return s0 + speed * T;
}

/**
 * Compute minimum safe gap for lane change at given speeds
 */
export function minLaneChangeGap(
  mySpeed: number,
  otherSpeed: number,
  params: typeof IDM = IDM
): number {
  const { s0, T, a, b } = params;

  // Use the IDM desired gap formula
  const deltaV = mySpeed - otherSpeed;
  const interaction = (mySpeed * deltaV) / (2 * Math.sqrt(a * b));
  return s0 + Math.max(0, mySpeed * T + interaction);
}

/**
 * Compute time-to-collision if closing in on leader
 */
export function timeToCollision(gap: number, approachRate: number): number {
  if (approachRate <= 0) {
    return Infinity; // Not closing in
  }
  return gap / approachRate;
}
