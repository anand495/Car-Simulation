# Parking Lot Simulation - Technical Documentation

## Project Objective

Simulate realistic vehicle flow in a parking lot environment, including:
- Vehicles entering from a main road
- Navigating through the lot to find parking spots
- Parking and later exiting during an "exodus" event
- Merging back onto the main road

The simulation models realistic physics, speed limits, and traffic flow to study congestion patterns and optimize lot design.

---

## Architecture Overview

### Design Principles

1. **Topology vs Behavior Separation**
   - **Topology** (`topology.ts`): Defines the physical layout - roads, spots, aisles, speed limits
   - **Behavior** (`simulation.ts`): Defines how cars act - state machine, path following, speed control
   - Cars are topology-agnostic: they can be placed in any topology and will adapt

2. **Speed Limit Enforcement**
   - Speed limits are defined as part of topology (property of roads/aisles)
   - Cars respect limits via `getSpeedLimitAtPosition()` function
   - Final speed = `min(state-based max speed, topology speed limit, gap-based speed)`

### Topology vs Behavior: When to Change What

Understanding where to make changes is critical for maintaining clean separation of concerns.

#### What Belongs in Topology (`topology.ts`)

| Responsibility | Examples |
|---------------|----------|
| **Physical layout** | Road positions, dimensions, lane counts |
| **Valid positions** | Where roads exist, where spots are located |
| **Speed limits** | Speed limit per road/aisle/area |
| **Path generation** | Waypoint sequences from A to B |
| **Geometric queries** | `isOnRoadSegment()`, `getLaneY()`, `getSpeedLimitAtPosition()` |

#### What Belongs in Behavior (`simulation.ts`)

| Responsibility | Examples |
|---------------|----------|
| **Movement rules** | "Stay in your lane", "Don't cut corners" |
| **State transitions** | When to change from APPROACHING to ENTERING |
| **Decision making** | When to change lanes, when to yield |
| **Physics** | Acceleration, braking, smooth motion |
| **Collision avoidance** | Safe following distance, gap checking |

#### Decision Guide: Where Should This Change Go?

| Change Type | Where | Rationale |
|-------------|-------|-----------|
| Add a new road | Topology | Physical layout change |
| Change road dimensions | Topology | Physical layout change |
| Add lane to existing road | Topology + Behavior | Topology defines lanes; behavior may need updated lane logic |
| Change how cars follow lanes | Behavior | Movement rule enforcement |
| Keep cars on paved areas | Behavior | Movement restriction enforcement |
| Add intermediate waypoints for turns | Topology | Path generation responsibility |
| Change state transition triggers | Behavior | Decision logic |
| Add speed limit to area | Topology | Property of the physical space |
| Change how cars accelerate | Behavior | Physics/movement rules |

#### Common Scenarios

**Scenario 1: Adding a new lane to a road**
- Topology: Update `lanes` count, adjust road `width`
- Behavior: Update lane change logic if it references specific lane numbers
- Path generation: May need to assign cars to new lane

**Scenario 2: Cars cutting across unpaved areas**
- Topology: Add intermediate waypoints to create proper turn paths
- Behavior: Update state transitions to check correct positions before changing state

**Scenario 3: Changing traffic flow direction**
- Topology: Update road `direction` property, regenerate paths
- Behavior: Update any hardcoded direction assumptions (e.g., heading angles)

**Scenario 4: Adding a traffic light**
- Topology: Add `TrafficLight` object to `trafficLights[]`
- Behavior: Add logic to detect lights, stop at red, proceed on green

#### Key Insight: Path Generation

Path generation is **defined in topology** but creates **vehicle-specific data**:

```typescript
// In topology.ts - generates path at spawn time
const path = generateEntryPath(topology, targetSpot, spawnLane);

// Path is stored on vehicle - behavior follows it
vehicle.path = path;
vehicle.pathIndex = 0;
```

The topology says "here's how to get from A to B", but the behavior says "here's how to follow that path correctly."

#### When Changing Topology Requires Behavior Changes

| Topology Change | Behavior Change Needed? |
|-----------------|------------------------|
| Move a road | Usually no - paths are regenerated |
| Change road dimensions | Maybe - if state transitions check specific positions |
| Add/remove lanes | Yes - lane logic needs updating |
| Change entry/exit points | Yes - state transitions reference these positions |
| Add new road segment | Yes - need state transitions for the new segment |
| Change speed limits | No - speed is queried dynamically |

#### Best Practice: Position-Based vs Hardcoded Checks

**Fragile (hardcoded):**
```typescript
// Breaks if entry road moves
if (vehicle.x > 500) {
  vehicle.state = 'ENTERING';
}
```

**Robust (position-based):**
```typescript
// Works regardless of topology changes
const entryRoadLeft = topology.entryRoad.x - topology.entryRoad.width / 2;
const entryRoadRight = topology.entryRoad.x + topology.entryRoad.width / 2;
if (pos.x >= entryRoadLeft && pos.x <= entryRoadRight) {
  vehicle.state = 'ENTERING';
}
```

---

## File Structure

```
parking-sim/
├── src/
│   ├── types.ts        # Type definitions, constants, interfaces
│   ├── topology.ts     # Lot layout generation, pathfinding, speed limit lookup
│   ├── simulation.ts   # Core simulation engine, vehicle behavior
│   ├── App.tsx         # React UI, canvas rendering
│   └── main.tsx        # Entry point
├── index.html
├── package.json
├── tsconfig.json
└── vite.config.ts
```

---

## Type Definitions (`types.ts`)

### Physical Constants

| Constant | Value | Description |
|----------|-------|-------------|
| `CAR_LENGTH` | 4.5m | Vehicle length |
| `CAR_WIDTH` | 1.8m | Vehicle width |
| `PARKING_SPOT_LENGTH` | 5.5m | Spot depth |
| `PARKING_SPOT_WIDTH` | 2.7m | Spot width |
| `AISLE_WIDTH` | 6.0m | Driving aisle width |
| `LANE_WIDTH` | 3.5m | Road lane width |

### Speed Constants (`SPEEDS`)

| Speed | Value | MPH | Usage |
|-------|-------|-----|-------|
| `PARKING_LOT` | 2.2 m/s | 5 mph | General lot driving |
| `AISLE` | 4.5 m/s | 10 mph | Driving through aisles |
| `EXIT_APPROACH` | 2.2 m/s | 5 mph | Approaching exit |
| `MERGE` | 3.0 m/s | 7 mph | Merging onto road |
| `MAIN_ROAD` | 13.4 m/s | 30 mph | On main road |
| `BACKUP` | 1.0 m/s | 2 mph | Reversing out of spot |
| `CREEP` | 0.5 m/s | 1 mph | Inching forward |

### Physics Constants (`PHYSICS`)

| Constant | Value | Description |
|----------|-------|-------------|
| `MAX_ACCELERATION` | 2.5 m/s² | Comfortable acceleration |
| `MAX_DECELERATION` | 4.0 m/s² | Comfortable braking |
| `EMERGENCY_DECEL` | 8.0 m/s² | Emergency stop |
| `SAFE_TIME_HEADWAY` | 1.5 sec | Following distance time |
| `MIN_GAP` | 2.0m | Minimum gap to car ahead |

### Layered State Architecture (v2.0)

The vehicle state model uses a layered architecture for scalability:

#### Layer 1: Location State (Where am I?)
```typescript
type LocationState =
  | 'ON_MAIN_ROAD'    // On the main road
  | 'ON_ENTRY_ROAD'   // On entry road into lot
  | 'ON_EXIT_ROAD'    // On exit road from lot
  | 'IN_LOT'          // Inside parking lot
  | 'IN_SPOT'         // Parked in a spot
  | 'EXITED';         // Left the simulation
```

#### Layer 2: Intent State (What am I trying to do?)
```typescript
type IntentState =
  | 'SEEKING_PARKING'   // Looking for/driving to a parking spot
  | 'PARKED'            // Stationary, waiting
  | 'EXITING_LOT'       // Leaving the parking lot
  | 'PASSING_THROUGH';  // Just driving through (road traffic)
```

#### Layer 3: Behavior Flags (Active micro-behaviors)
```typescript
interface BehaviorFlags {
  isReversing: boolean;        // Moving backward
  isChangingLane: boolean;     // Actively changing lanes
  isYielding: boolean;         // Yielding to another vehicle
  isMerging: boolean;          // Actively merging into traffic
  isWaitingAtLight: boolean;   // Stopped at traffic light
  isWaitingToMerge: boolean;   // Waiting for gap to merge
  isWaitingForSpot: boolean;   // Waiting for spot to clear
  laneChangeProgress: number;  // 0 to 1, progress through lane change
  laneChangeDirection: 'left' | 'right' | null;
}
```

#### Layer 4: Traffic Control State
```typescript
interface TrafficControlState {
  nearestLightId: string | null;
  lightColor: TrafficLightColor | null;
  distanceToLight: number;
  mustStop: boolean;
}
```

### Legacy Vehicle State Machine (Compatibility)

```
Entry Flow:
APPROACHING → ENTERING → NAVIGATING_TO_SPOT → PARKING → PARKED

Exit Flow:
PARKED → EXITING_SPOT → DRIVING_TO_EXIT → IN_EXIT_LANE → AT_MERGE_POINT → MERGING → ON_ROAD → EXITED
```

| State | Description | Max Speed | Location |
|-------|-------------|-----------|----------|
| `APPROACHING` | On main road, heading toward entry | 13.4 m/s | Main road |
| `ENTERING` | Turning into entry road | 2.2 m/s | Entry road |
| `NAVIGATING_TO_SPOT` | Driving through lot to spot | 4.5 m/s | Lot/Aisles |
| `PARKING` | Pulling into the spot | 0.5 m/s | Near spot |
| `PARKED` | Stationary in spot | 0 m/s | In spot |
| `EXITING_SPOT` | Backing out of spot | 1.0 m/s | Spot/Aisle |
| `DRIVING_TO_EXIT` | Navigating toward exit | 4.5 m/s | Lot/Aisles |
| `IN_EXIT_LANE` | On exit road | 2.2 m/s | Exit road |
| `AT_MERGE_POINT` | Waiting to merge | 0 m/s | Exit road top |
| `MERGING` | Accelerating onto main road | 3.0 m/s | Transition |
| `ON_ROAD` | Driving away on main road | 13.4 m/s | Main road |
| `EXITED` | Left simulation | N/A | Off-screen |

### Key Interfaces

#### Vehicle
```typescript
interface Vehicle {
  id: number;

  // Position and orientation
  x: number;
  y: number;
  heading: number;              // Radians (0 = east, π/2 = north)

  // Kinematics
  speed: number;                // Current speed (m/s)
  targetSpeed: number;          // What we're accelerating toward
  acceleration: number;         // Current acceleration

  // Layered State Model
  location: LocationState;      // Where am I?
  intent: IntentState;          // What am I trying to do?
  behaviors: BehaviorFlags;     // Active micro-behaviors
  trafficControl: TrafficControlState; // Traffic light awareness

  // Lane tracking
  currentLane: number | null;   // Current lane (0 = leftmost)
  targetLane: number | null;    // Target lane for lane change
  laneChangeStartY: number | null;

  // Legacy state (compatibility)
  state: VehicleState;

  // Navigation
  targetSpotId: number | null;  // Assigned parking spot
  path: Point[];                // Waypoints to follow
  pathIndex: number;            // Current waypoint

  // Timing and visual
  spawnTime: number;
  parkTime: number | null;
  waitTime: number;
  color: string;
}
```

#### RoadSegment
```typescript
interface RoadSegment {
  id: string;
  x: number;                    // Start x (horizontal) or center x (vertical)
  y: number;                    // Center y (horizontal) or start y (vertical)
  length: number;
  width: number;                // Total width (lanes × lane width)
  lanes: number;
  orientation: 'horizontal' | 'vertical';
  direction: 'east' | 'west' | 'north' | 'south';
  speedLimit: number;           // m/s
}
```

#### Topology
```typescript
interface Topology {
  mainRoad: RoadSegment;        // 3 lanes, westbound
  entryRoad: RoadSegment;       // 2 lanes, southbound
  exitRoad: RoadSegment;        // 2 lanes, northbound
  lot: {
    x, y, width, height: number;
    speedLimit: number;
  };
  entryPoint: Point;            // Where entry road meets lot
  exitPoint: Point;             // Where exit road leaves lot
  aisles: Aisle[];
  spots: ParkingSpot[];
  trafficLights: TrafficLight[]; // Traffic control infrastructure
}
```

#### TrafficLight
```typescript
interface TrafficLight {
  id: string;
  x: number;
  y: number;
  controlsDirection: 'north' | 'south' | 'east' | 'west';
  color: TrafficLightColor;     // 'red' | 'yellow' | 'green'
  greenDuration: number;        // seconds
  yellowDuration: number;
  redDuration: number;
  currentPhaseTime: number;
  roadSegmentId: string;
  stopLinePosition: number;
}
```

---

## Topology (`topology.ts`)

### Layout Diagram

```
     ←←←←←←←←←←← Main Road (3 lanes, westbound) ←←←←←←←←←←←
                    ↑              │
                    │              ↓
                Exit Road      Entry Road
                (2 lanes)      (2 lanes)
                    ↑              ↓
              ┌─────┴──────────────┴─────┐
              │                          │
              │      Parking Lot         │
              │    ══════════════════    │ ← aisles with spots on both sides
              │    ══════════════════    │
              │                          │
              └──────────────────────────┘
```

### Lot Generation (`createStandardLot`)

- 500 spots by default
- 25 spots per side of aisle (50 per aisle)
- 10 aisles for 500 spots
- Aisles alternate direction (east/west)
- Entry road on right side, exit road on left side

### Speed Limit Lookup (`getSpeedLimitAtPosition`)

Priority order:
1. Main road → 13.4 m/s
2. Entry road → 2.2 m/s
3. Exit road → 2.2 m/s
4. Aisle → 4.5 m/s
5. Lot (default) → 2.2 m/s

### Pathfinding

Waypoints are stored as `path: Point[]` on each vehicle, generated at spawn time.

**Entry Path** (`generateEntryPath(topology, spot, spawnLane)`):
1. Start on main road in spawn lane (y controlled by lane logic, not path)
2. Drive west to entry road x-position (must be in lane 0 by this point)
3. Turn south onto entry road (randomly assigned to left or right lane)
4. Enter lot
5. Navigate to right corridor
6. Drive down to target aisle
7. Turn into aisle
8. Pull into spot

**Exit Path** (`generateExitPath(topology, spot)`):
1. Start at spot
2. Back out into aisle
3. Drive through aisle to left corridor
4. Navigate up to exit point
5. Drive up exit road (randomly assigned to left or right lane)
6. Merge onto main road (lane 0)
7. Drive west until off-screen

---

## Simulation Engine (`simulation.ts`)

### Main Loop (`step`)

Each frame:
1. Update spatial grid for neighbor lookups
2. Spawn road traffic (grey background vehicles)
3. Update all vehicles (state, speed, position)
4. Resolve collisions
5. Update counters and metrics
6. Check phase transitions

### Speed Computation (`computeTargetSpeed`)

```typescript
targetSpeed = min(
  stateMaxSpeed,           // Based on vehicle state
  topologySpeedLimit,      // Based on position
  densityAdjustedSpeed,    // Reduced in congested areas
  gapBasedSpeed            // Safe following distance
)
```

### Vehicle Movement (`followPath`)

- Normal: Turn toward next waypoint, move forward
- Reversing: Move backward without turning (for exiting spots)
- Waypoint reached when within 2m, advance to next

**Main Road Special Handling:**
- While on main road (not at turn point): y-position locked to current lane
- Only x-distance checked for waypoint completion
- Heading fixed to π (west)

**Turn Point Detection:**
- When vehicle reaches entry road x-position AND is in lane 0:
  - `isAtTurnPoint` becomes true
  - Advances `pathIndex` to 2 (skips stale main road waypoints)
  - Sets heading to south (`-π/2`) immediately
  - Switches to normal path following for entry road

**Why skip waypoints at turn point:**
- Path indices 0-1 are main road waypoints, handled by lane logic (not path following)
- When `isAtTurnPoint` triggers, these waypoints may be behind the car
- Without skipping, `angleTo()` would point backward → car spins 360°
- Advancing to index 2 and setting heading south prevents this

### Lane Distribution

**Main Road (3 lanes, horizontal, westbound):**
- Lane 0 = bottom (south, closest to lot) - required for turning into entry road
- Lane 1 = middle
- Lane 2 = top (north)
- **Grey traffic** (roadVehicles): Randomly distributed across all 3 lanes
- **Green cars** (entering): Spawn in random lane, must change to lane 0 to enter
- **Cyan cars** (exiting): Merge into lane 0

**Entry Road (2 lanes, vertical, southbound):**
- Lane 0 = left (west)
- Lane 1 = right (east)
- Cars randomly assigned to either lane

**Exit Road (2 lanes, vertical, northbound):**
- Lane 0 = left (west)
- Lane 1 = right (east)
- Cars randomly assigned to either lane

### Lane Changing (v2.2)

Vehicles on the main road can change lanes to reach the entry road.

**Lane Change Parameters:**
| Parameter | Value | Description |
|-----------|-------|-------------|
| `LANE_CHANGE_MIN_GAP` | 8.0m | Minimum gap needed in target lane |
| `LANE_CHANGE_TIME` | 2.0s | Duration of lane change maneuver |
| `LANE_CHANGE_LOOK_AHEAD` | 50m | Distance to check ahead for entry |
| `LANE_CHANGE_LOOK_BEHIND` | 30m | Distance to check behind for safety |

**Lane Change Logic:**
1. Cars spawn in random lane (0, 1, or 2) on main road
2. While on main road, y-position is controlled by lane logic (not pathfinding)
3. Check if vehicle needs to be in lane 0 (bottom) for entry
4. Verify sufficient distance to entry road (50-150m ahead)
5. Check gap in target lane - ahead (8m) and behind (30m)
6. For vehicles behind, calculate time-to-close (must be > 3 seconds)
7. If safe, execute smooth lane change with ease-in-out interpolation
8. Once in lane 0, turn right into entry road

**Visual Indicators:**
- Vehicles changing lanes pulse yellow
- Turn signal indicator shows on the side of intended direction

### Collision Resolution

- Uses spatial grid for O(1) neighbor lookups
- Priority system: cars closer to exit have priority
- Lower priority car stops when collision detected

---

## Rendering (`App.tsx`)

### Coordinate System

- World coordinates: origin at bottom-left, y increases upward
- Screen coordinates: origin at top-left, y increases downward
- `worldToScreen()` converts between systems with camera offset and zoom

### Vehicle Colors by State

| State | Color | Hex |
|-------|-------|-----|
| APPROACHING, ENTERING, NAVIGATING, PARKING | Green | #4ade80 |
| PARKED | Blue | #3b82f6 |
| EXITING_SPOT, DRIVING_TO_EXIT, IN_EXIT_LANE | Orange | #f97316 |
| AT_MERGE_POINT | Yellow | #eab308 |
| MERGING, ON_ROAD | Cyan | #22d3ee |
| Road traffic | Grey | #666666 |

### Camera Controls

- Mouse drag: Pan
- Mouse wheel: Zoom
- Touch: Pan and pinch-to-zoom

---

## Simulation Phases

| Phase | Description |
|-------|-------------|
| `IDLE` | Initial state, no activity |
| `FILLING` | Vehicles spawning and parking |
| `WAITING` | All vehicles parked, waiting for exodus |
| `EXODUS` | All parked vehicles exiting |
| `COMPLETE` | All vehicles have exited |

---

## Configuration (`SimConfig`)

| Option | Default | Description |
|--------|---------|-------------|
| `numSpots` | 500 | Number of parking spots |
| `roadTrafficRate` | 30 | Vehicles per minute on main road |
| `staggerExitSeconds` | 60 | Spread exodus over this many seconds |
| `showDebug` | false | Show debug overlays |

---

## Implementation History

### Version 1.0 - Initial Setup
- React + Vite + TypeScript project
- Basic canvas rendering
- Vehicle spawning and movement

### Version 1.1 - Parking Snap Fix
- Fixed cars not snapping to parking spots
- Increased PARKING threshold from 0.5m to 2m
- Adjusted NAVIGATING_TO_SPOT transition logic

### Version 1.2 - Removed Fixed Facing Direction
- Removed `facing` property from ParkingSpot
- Cars park from whichever direction they approach (realistic behavior)

### Version 1.3 - Reversing Capability
- Added `isReversing` boolean to Vehicle
- Cars now back out of spots (move opposite to heading)
- Set during EXITING_SPOT state

### Version 1.4 - Topology Redesign
- Replaced access road with proper road network:
  - 3-lane one-way main road (westbound)
  - 2-lane entry road (southbound into lot)
  - 2-lane exit road (northbound to main road)
- Speed limits defined in topology
- `getSpeedLimitAtPosition()` for position-based lookup

### Version 1.5 - Speed Limit Enforcement
- Fixed APPROACHING state to use MAIN_ROAD speed (was using PARKING_LOT)
- Cars now properly travel at 30 mph on main road
- State-based speeds align with topology speed limits

### Version 1.6 - Lane Distribution
- Grey traffic distributed across all 3 lanes (was single lane)
- Green entering cars spawn in bottom lane
- Road vehicles face west (added rotation to rendering)
- Path generation uses correct lane y-positions

### Version 2.0 - Layered State Architecture
- **Breaking Change**: Complete refactor of vehicle state model
- Introduced 4-layer architecture:
  - Layer 1: LocationState (physical location)
  - Layer 2: IntentState (goal/purpose)
  - Layer 3: BehaviorFlags (active micro-behaviors)
  - Layer 4: TrafficControlState (traffic light awareness)
- Added lane tracking (`currentLane`, `targetLane`)
- Legacy `VehicleState` maintained for compatibility

### Version 2.1 - Traffic Lights Infrastructure
- Added `TrafficLight` interface to topology
- Supports red/yellow/green phases with configurable timing
- Framework ready for complex intersection topologies

### Version 2.2 - Realistic Lane Changing
- Vehicles can change lanes on main road
- Gap-based safety checks (ahead and behind)
- Time-to-close calculation for vehicles behind
- Smooth ease-in-out lane change animation
- Visual indicators (pulsing yellow, turn signals)
- Lane change triggers when approaching entry road

### Version 2.3 - Multi-Lane Entry/Exit Roads
- Entry road now uses both lanes (was single lane)
- Exit road now uses both lanes (was single lane)
- Cars randomly assigned to left or right lane on entry/exit roads
- Entering cars spawn in random main road lane (was always bottom)
- Main road y-position controlled by lane logic, not pathfinding
- Lane 0 = bottom/south (closest to lot), Lane 2 = top/north
- Fixed lane numbering confusion (was inverted)

### Version 2.4 - Topology vs Behavior Design Documentation
- Added comprehensive "Topology vs Behavior: When to Change What" section
- Documented responsibilities of topology.ts vs simulation.ts
- Added decision guide table for common change types
- Included common scenarios with where-to-change guidance
- Documented path generation as topology-defined but vehicle-specific
- Added best practice examples (position-based vs hardcoded checks)
- Intermediate waypoints added to prevent cars cutting corners during turns

### Version 2.5 - Turn Point Detection Fix
- Fixed bug where cars could not enter the parking lot
- **Root cause**: On main road, y-position was locked to current lane, preventing turns
- **Solution**: Added `isAtTurnPoint` detection in `followPath()`
- When vehicle is on main road AND at entry road x-position AND in lane 0:
  - Switches from lane-locked movement to normal path following
  - Allows vehicle to turn south onto entry road
- This is an example of behavior needing to handle topology transitions correctly

### Version 2.6 - Turn Circle Bug Fix
- Fixed bug where cars spun in a full circle when turning into entry road
- **Root cause**: When `isAtTurnPoint` triggered, `pathIndex` was still 0 or 1, pointing to
  waypoints behind or at the car's position. The `angleTo()` calculation pointed backward,
  causing the car to rotate 360° trying to reach a waypoint it had already passed.
- **Solution**: When at turn point with `pathIndex < 2`:
  - Advance `pathIndex` to 2 (the "just below main road" waypoint)
  - Set `heading` to `-π/2` (south) immediately
- **Path structure**: `[spawn, entry road x on main road, below main road, ...]`
  - Index 0-1: Main road waypoints (handled by lane logic, not path following)
  - Index 2+: Entry road and lot waypoints (handled by normal path following)

---

## Known Limitations

1. No lane changing for background road traffic (grey vehicles)
2. Single-file movement in aisles (no passing)
3. Simplified merging logic (gap-based only)
4. No pedestrians
5. All vehicles same size
6. Traffic lights defined but not yet active in simulation loop

---

## Future Enhancements (Potential)

- [x] Lane changing on main road (implemented v2.2)
- [x] Traffic light infrastructure (implemented v2.1)
- [ ] Activate traffic light simulation loop
- [ ] Lane changing for background road traffic
- [ ] Proper collision avoidance (not just detection)
- [ ] Different vehicle types/sizes
- [ ] Pedestrian simulation
- [ ] Time-based demand patterns
- [ ] Multiple entry/exit points
- [ ] Handicap spot prioritization
- [ ] Real-time analytics dashboard
- [ ] Complex intersection topologies
