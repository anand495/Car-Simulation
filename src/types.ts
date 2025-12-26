// ============================================================================
// PARKING FLOW SIMULATION - TYPE DEFINITIONS
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

// ----------------------------------------------------------------------------
// VEHICLE STATES
// ----------------------------------------------------------------------------
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
  isReversing: boolean;   // true when backing up (moving opposite to heading)

  // State machine
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
}

export const DEFAULT_CONFIG: SimConfig = {
  numSpots: 500,
  roadTrafficRate: 30,
  staggerExitSeconds: 60,
  showDebug: false,
};

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
