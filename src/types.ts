// ============================================================================
// PARKING FLOW SIMULATION - TYPE DEFINITIONS
// ============================================================================
// Architecture: Layered State Model
// - Layer 1: LocationState (where am I physically?)
// - Layer 2: IntentState (what is my goal?)
// - Layer 3: BehaviorFlags (what micro-behaviors are active?)
// - Layer 4: TrafficControlState (traffic light/sign awareness)
// ============================================================================

// ----------------------------------------------------------------------------
// REALISTIC DIMENSIONS (meters)
// ----------------------------------------------------------------------------
export const CAR_LENGTH = 4.5;
export const CAR_WIDTH = 1.8;
export const PARKING_SPOT_LENGTH = 5.5;
export const PARKING_SPOT_WIDTH = 2.7;
export const AISLE_WIDTH = 6.0;
export const LANE_WIDTH = 3.5;

// ----------------------------------------------------------------------------
// SPEEDS (m/s) - Converted from mph
// ----------------------------------------------------------------------------
export const SPEEDS = {
  PARKING_LOT: 2.2,      // 5 mph - general lot driving
  AISLE: 4.5,            // 10 mph - driving through aisles
  EXIT_APPROACH: 2.2,    // 5 mph - approaching exit
  MERGE: 3.0,            // 7 mph - merging onto road
  MAIN_ROAD: 13.4,       // 30 mph - on main road
  BACKUP: 1.0,           // 2 mph - reversing out of spot
  CREEP: 0.5,            // 1 mph - inching forward in queue
  LANE_CHANGE: 8.9,      // 20 mph - during lane change (maintain reasonable speed)
} as const;

// ----------------------------------------------------------------------------
// PHYSICS CONSTANTS
// ----------------------------------------------------------------------------
export const PHYSICS = {
  MAX_ACCELERATION: 2.5,      // m/s² - comfortable acceleration
  MAX_DECELERATION: 4.0,      // m/s² - comfortable braking
  EMERGENCY_DECEL: 8.0,       // m/s² - emergency stop
  SAFE_TIME_HEADWAY: 1.5,     // seconds - following distance
  MIN_GAP: 2.0,               // meters - minimum gap to car ahead
  JAM_DENSITY: 0.15,          // vehicles per m² at full jam
  CRITICAL_DENSITY: 0.08,     // vehicles per m² at max flow
  // Lane change parameters
  LANE_CHANGE_MIN_GAP: 8.0,   // meters - min gap needed to change lanes
  LANE_CHANGE_TIME: 2.0,      // seconds - time to complete lane change
  LANE_CHANGE_LOOK_AHEAD: 50, // meters - how far ahead to check for lane change need
  LANE_CHANGE_LOOK_BEHIND: 30,// meters - how far behind to check for safety
} as const;

// ----------------------------------------------------------------------------
// IDM (Intelligent Driver Model) Parameters
// Based on Treiber, Hennecke & Helbing (2000)
// Context-aware: different parameters for different driving situations
// ----------------------------------------------------------------------------

// IDM parameter interface
export interface IDMParams {
  T: number;      // Time headway (seconds)
  s0: number;     // Minimum gap / jam distance (meters)
  a: number;      // Comfortable acceleration (m/s²)
  b: number;      // Comfortable deceleration (m/s²)
  delta: number;  // Acceleration exponent
}

// Highway/main road parameters (standard IDM)
export const IDM: IDMParams = {
  T: 1.5,                     // seconds - comfortable highway following
  s0: 2.0,                    // meters - minimum bumper-to-bumper gap
  a: 2.5,                     // m/s² - comfortable acceleration
  b: 4.0,                     // m/s² - comfortable deceleration
  delta: 4,                   // dimensionless
};

// Parking lot / urban parameters (tighter following, slower speeds)
export const IDM_PARKING: IDMParams = {
  T: 1.0,                     // seconds - shorter following in parking lot
  s0: 1.5,                    // meters - tighter jam distance at low speeds
  a: 2.0,                     // m/s² - gentler acceleration
  b: 3.0,                     // m/s² - gentler braking
  delta: 4,
};

// Merge/lane-change parameters (more aggressive for merging)
export const IDM_MERGE: IDMParams = {
  T: 1.2,                     // seconds - slightly tighter for merging
  s0: 1.5,                    // meters - accept tighter gaps
  a: 2.5,                     // m/s² - normal acceleration
  b: 4.0,                     // m/s² - normal braking
  delta: 4,
};

// ----------------------------------------------------------------------------
// MOBIL (Minimizing Overall Braking Induced by Lane changes) Parameters
// Based on Kesting, Treiber & Helbing (2007)
// ----------------------------------------------------------------------------
export const MOBIL = {
  // Politeness factor: 0 = selfish, 1 = altruistic
  // Optimized from 0.5 to 0.4 - slightly less polite reduces collisions
  p: 0.4,
  // Threshold acceleration gain required to change lanes
  athreshold: 0.2,            // m/s² - minimum improvement required
  // Maximum safe braking imposed on follower in target lane
  bsafe: 4.0,                 // m/s² - must not force follower to brake harder than this
  // Bias toward right lane (for staying right)
  abias: 0.3,                 // m/s² - slight preference for right lanes
} as const;

// ----------------------------------------------------------------------------
// SPATIAL GRID (for efficient neighbor lookups)
// ----------------------------------------------------------------------------
export const GRID_CELL_SIZE = 10; // meters per grid cell

// ----------------------------------------------------------------------------
// BASIC GEOMETRY
// ----------------------------------------------------------------------------
export interface Point {
  x: number;
  y: number;
}

export interface Rectangle {
  x: number;      // center x
  y: number;      // center y
  width: number;
  height: number;
  rotation: number; // radians
}

// ============================================================================
// LAYER 1: LOCATION STATE (Where am I physically?)
// ============================================================================
export type LocationState =
  | 'ON_MAIN_ROAD'       // On the main road
  | 'ON_ENTRY_ROAD'      // On entry road into lot
  | 'ON_EXIT_ROAD'       // On exit road from lot
  | 'IN_LOT'             // Inside parking lot (corridors, aisles)
  | 'IN_SPOT'            // Parked in a spot
  | 'EXITED';            // Left the simulation

// ============================================================================
// LAYER 2: INTENT STATE (What is my goal?)
// ============================================================================
export type IntentState =
  | 'SEEKING_PARKING'    // Looking for/driving to a parking spot
  | 'PARKED'             // Stationary, waiting
  | 'EXITING_LOT'        // Leaving the parking lot
  | 'PASSING_THROUGH';   // Just driving through (road traffic)

// ============================================================================
// LAYER 3: BEHAVIOR FLAGS (Active micro-behaviors that modify movement)
// ============================================================================
export interface BehaviorFlags {
  // Movement behaviors
  isReversing: boolean;        // Moving backward (opposite to heading)
  isChangingLane: boolean;     // Actively changing lanes
  isYielding: boolean;         // Yielding to another vehicle
  isMerging: boolean;          // Actively merging into traffic

  // Waiting behaviors
  isWaitingAtLight: boolean;   // Stopped at traffic light
  isWaitingToMerge: boolean;   // Waiting for gap to merge
  isWaitingForSpot: boolean;   // Waiting for spot to clear

  // Lane change tracking
  laneChangeProgress: number;  // 0 to 1, progress through lane change
  laneChangeDirection: 'left' | 'right' | null;  // Which direction changing
}

// ============================================================================
// LAYER 4: TRAFFIC CONTROL STATE (Traffic light/sign awareness)
// ============================================================================
export type TrafficLightColor = 'red' | 'yellow' | 'green';

export interface TrafficControlState {
  nearestLightId: string | null;       // ID of nearest traffic light
  lightColor: TrafficLightColor | null; // Current color of that light
  distanceToLight: number;              // Distance to the light
  mustStop: boolean;                    // Whether we must stop for this light
}

// Default behavior flags (all inactive)
export const DEFAULT_BEHAVIOR_FLAGS: BehaviorFlags = {
  isReversing: false,
  isChangingLane: false,
  isYielding: false,
  isMerging: false,
  isWaitingAtLight: false,
  isWaitingToMerge: false,
  isWaitingForSpot: false,
  laneChangeProgress: 0,
  laneChangeDirection: null,
};

// ============================================================================
// LEGACY VEHICLE STATE (kept for compatibility, maps to new layers)
// ============================================================================
export type VehicleState =
  | 'APPROACHING'        // Coming from access road toward entry
  | 'ENTERING'           // Entering the lot through entry gate
  | 'NAVIGATING_TO_SPOT' // Driving through lot to assigned spot
  | 'PARKING'            // Maneuvering into the parking spot
  | 'PARKED'             // Stationary, waiting for event
  | 'EXITING_SPOT'       // Backing out of parking spot
  | 'DRIVING_TO_EXIT'    // Driving through lot toward exit lane
  | 'IN_EXIT_LANE'       // In one of the exit lanes
  | 'AT_MERGE_POINT'     // At merge point, waiting to merge
  | 'MERGING'            // Actively merging onto main road
  | 'ON_ROAD'            // On main road, accelerating away
  | 'EXITED';            // Off screen, simulation complete for this car

// ----------------------------------------------------------------------------
// VEHICLE
// ----------------------------------------------------------------------------
export interface Vehicle {
  id: number;

  // Position and orientation
  x: number;
  y: number;
  heading: number;        // radians, 0 = east, π/2 = north

  // Kinematics
  speed: number;          // m/s
  targetSpeed: number;    // m/s - what we're accelerating toward
  acceleration: number;   // m/s² - current acceleration

  // =========================================================================
  // LAYERED STATE MODEL
  // =========================================================================

  // Layer 1: Location (where am I?)
  location: LocationState;

  // Layer 2: Intent (what am I trying to do?)
  intent: IntentState;

  // Layer 3: Active behaviors (what micro-behaviors are active?)
  behaviors: BehaviorFlags;

  // Layer 4: Traffic control awareness
  trafficControl: TrafficControlState;

  // Lane tracking (for lane changes on multi-lane roads)
  currentLane: number | null;   // Current lane (0 = leftmost/top)
  targetLane: number | null;    // Target lane for lane change
  laneChangeStartY: number | null; // Y position when lane change started

  // Legacy state (for compatibility during transition)
  state: VehicleState;

  // Navigation
  targetSpotId: number | null;
  exitLaneId: number | null;
  path: Point[];
  pathIndex: number;

  // Timing (for metrics and stuck detection)
  spawnTime: number;
  parkTime: number | null;
  exitStartTime: number | null;
  exitCompleteTime: number | null;
  waitTime: number;       // accumulated wait time (for stuck detection)

  // Visual
  color: string;
}

// ----------------------------------------------------------------------------
// ROAD SEGMENT (shared structure for all roads)
// ----------------------------------------------------------------------------
export interface RoadSegment {
  id: string;
  // Position - can be horizontal or vertical
  x: number;              // center x (for vertical roads) or start x (for horizontal)
  y: number;              // center y (for horizontal roads) or start y (for vertical)
  length: number;         // length of the road
  width: number;          // total width (lanes * lane width)
  lanes: number;
  orientation: 'horizontal' | 'vertical';
  direction: 'east' | 'west' | 'north' | 'south';  // traffic flow direction
  speedLimit: number;     // m/s
}

// ----------------------------------------------------------------------------
// PARKING INFRASTRUCTURE
// ----------------------------------------------------------------------------
export interface ParkingSpot {
  id: number;
  x: number;              // center of spot
  y: number;
  aisleId: number;        // which aisle this spot faces
  occupied: boolean;
  vehicleId: number | null;
}

export interface Aisle {
  id: number;
  y: number;              // y-coordinate of aisle center
  xStart: number;
  xEnd: number;
  direction: 'east' | 'west' | 'both';
  speedLimit: number;     // m/s
}

// ----------------------------------------------------------------------------
// TRAFFIC LIGHT (Part of Topology)
// ----------------------------------------------------------------------------
export interface TrafficLight {
  id: string;
  // Position
  x: number;
  y: number;
  // What this light controls
  controlsDirection: 'north' | 'south' | 'east' | 'west';
  // Current state
  color: TrafficLightColor;
  // Timing (in seconds)
  greenDuration: number;
  yellowDuration: number;
  redDuration: number;
  currentPhaseTime: number;   // Time spent in current phase
  // Association
  roadSegmentId: string;      // Which road segment this light is on
  stopLinePosition: number;   // Distance along road where cars should stop
}

// ----------------------------------------------------------------------------
// TOPOLOGY (Complete parking lot layout)
// ----------------------------------------------------------------------------
export interface Topology {
  // Main road (3 lanes, one-way)
  mainRoad: RoadSegment;

  // Entry road from main road into lot (2 lanes)
  entryRoad: RoadSegment;

  // Exit road from lot back to main road (2 lanes)
  exitRoad: RoadSegment;

  // Parking lot bounds
  lot: {
    x: number;            // left edge
    y: number;            // bottom edge
    width: number;
    height: number;
    speedLimit: number;   // m/s - default speed in lot
  };

  // Connection points
  entryPoint: Point;      // where entry road meets lot
  exitPoint: Point;       // where exit road leaves lot

  // Internal structure
  aisles: Aisle[];
  spots: ParkingSpot[];

  // Traffic control infrastructure
  trafficLights: TrafficLight[];
}

// ----------------------------------------------------------------------------
// ROAD TRAFFIC (background vehicles on main road)
// ----------------------------------------------------------------------------
export interface RoadVehicle {
  id: number;
  x: number;
  y: number;
  lane: number;
  speed: number;
  // Lane change support for road vehicles too
  targetLane: number | null;
  laneChangeProgress: number;
}

// ----------------------------------------------------------------------------
// SIMULATION STATE
// ----------------------------------------------------------------------------
export type SimulationPhase = 'IDLE' | 'FILLING' | 'WAITING' | 'EXODUS' | 'COMPLETE';

export interface SimulationState {
  time: number;               // simulation time in seconds
  phase: SimulationPhase;

  vehicles: Vehicle[];
  roadVehicles: RoadVehicle[];

  // Counters
  totalSpawned: number;
  parkedCount: number;
  exitedCount: number;

  // Metrics
  avgExitTime: number | null;
  throughput: number;         // vehicles per minute exiting
}

// ----------------------------------------------------------------------------
// SIMULATION CONFIGURATION
// ----------------------------------------------------------------------------
export interface SimConfig {
  numSpots: number;
  roadTrafficRate: number;    // vehicles per minute on main road
  staggerExitSeconds: number; // spread exodus start over this many seconds
  showDebug: boolean;
  enableLogging: boolean;     // capture vehicle state history
  logInterval: number;        // seconds between log captures (0 = every frame)
}

export const DEFAULT_CONFIG: SimConfig = {
  numSpots: 500,
  roadTrafficRate: 30,
  staggerExitSeconds: 60,
  showDebug: false,
  enableLogging: true,
  logInterval: 0.5,           // capture every 0.5 seconds
};

// ----------------------------------------------------------------------------
// SIMULATION LOGGING (for debugging)
// ----------------------------------------------------------------------------

/** Snapshot of a single vehicle at a point in time */
export interface VehicleSnapshot {
  id: number;
  timestamp: number;

  // Position
  x: number;
  y: number;
  heading: number;

  // Kinematics
  speed: number;
  targetSpeed: number;

  // State
  state: VehicleState;
  location: LocationState;
  intent: IntentState;

  // Behaviors
  isChangingLane: boolean;
  isReversing: boolean;
  isMerging: boolean;
  isWaitingToMerge: boolean;

  // Lane info
  currentLane: number | null;
  targetLane: number | null;

  // Navigation
  targetSpotId: number | null;
  pathIndex: number;
  pathLength: number;

  // Timing
  waitTime: number;
}

/** Complete simulation log */
export interface SimulationLog {
  startTime: Date;
  snapshots: VehicleSnapshot[];
  events: SimulationEvent[];
}

/** Discrete events that occur during simulation */
export interface SimulationEvent {
  timestamp: number;
  vehicleId: number;
  type: 'SPAWN' | 'PARKED' | 'EXIT_START' | 'EXITED' | 'LANE_CHANGE_START' | 'LANE_CHANGE_END' | 'STUCK';
  details?: Record<string, unknown>;
}

// ----------------------------------------------------------------------------
// COLORS (for visualization)
// ----------------------------------------------------------------------------
export const COLORS = {
  background: '#1a1a2e',
  road: '#3d3d5c',
  roadMarkings: '#666680',
  lot: '#2d2d44',
  aisle: '#3d3d5c',
  spotEmpty: '#252538',
  spotOccupied: '#1e3a5f',

  // Vehicle states
  vehicle: {
    APPROACHING: '#4ade80',      // green
    ENTERING: '#4ade80',
    NAVIGATING_TO_SPOT: '#4ade80',
    PARKING: '#4ade80',
    PARKED: '#3b82f6',           // blue
    EXITING_SPOT: '#f97316',     // orange
    DRIVING_TO_EXIT: '#f97316',
    IN_EXIT_LANE: '#f97316',
    AT_MERGE_POINT: '#eab308',   // yellow
    MERGING: '#22d3ee',          // cyan
    ON_ROAD: '#22d3ee',
    EXITED: '#666666',           // gray
  } as Record<VehicleState, string>,

  vehicleWaiting: '#ef4444',     // red - for stuck vehicles

  exitLane: '#4a4a6a',
  mergePoint: '#5a5a7a',
} as const;
