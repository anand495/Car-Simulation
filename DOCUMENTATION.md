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

---

### Context-Aware Behavior Architecture

Cars behave differently depending on **where they are** and **what they're doing**. The architecture uses a layered state model to enable extensible, context-specific behaviors.

#### The Four-Layer State Model

Each vehicle maintains four independent state layers:

```typescript
interface Vehicle {
  // Layer 1: Location (WHERE am I physically?)
  location: LocationState;  // ON_MAIN_ROAD, ON_ENTRY_ROAD, IN_LOT, IN_SPOT, etc.

  // Layer 2: Intent (WHAT is my goal?)
  intent: IntentState;      // SEEKING_PARKING, PARKED, EXITING_LOT, PASSING_THROUGH

  // Layer 3: Behavior Flags (WHAT micro-behaviors are active?)
  behaviors: BehaviorFlags; // isReversing, isChangingLane, isYielding, etc.

  // Layer 4: Traffic Control (WHAT traffic rules apply?)
  trafficControl: TrafficControlState; // nearestLightId, mustStop, etc.
}
```

#### Why Four Layers?

| Layer | Purpose | Example Query |
|-------|---------|---------------|
| **Location** | Physical context | "Am I in an aisle?" → Enable obstacle avoidance |
| **Intent** | Goal context | "Am I seeking parking?" → Need lane 0 for entry |
| **Behaviors** | Active micro-actions | "Am I reversing?" → Move backward, don't steer |
| **Traffic Control** | Rule compliance | "Is light red?" → Must stop |

#### Context-Based Behavior Dispatch

Behaviors are selected based on context. This pattern makes the system extensible:

```typescript
// Example: Different behaviors based on location
private followPath(vehicle: Vehicle, dt: number): void {
  // Context: On main road
  if (vehicle.location === 'ON_MAIN_ROAD') {
    // Main road behaviors: lane-locked, westbound driving
    this.handleMainRoadMovement(vehicle, dt);
    return;
  }

  // Context: In parking lot
  if (vehicle.location === 'IN_LOT') {
    // Lot behaviors: obstacle avoidance, waypoint following
    this.handleLotMovement(vehicle, dt);
    return;
  }

  // Context: On entry/exit road
  // Different behaviors for vertical road segments
  this.handleVerticalRoadMovement(vehicle, dt);
}
```

#### Adding New Behaviors (Extensibility Guide)

**Step 1: Identify the Context**
- What location(s) should trigger this behavior?
- What intent(s) should trigger this behavior?
- What existing behaviors might conflict?

**Step 2: Add Behavior Flag (if needed)**
```typescript
// In types.ts - BehaviorFlags interface
interface BehaviorFlags {
  // ... existing flags
  isNewBehavior: boolean;  // Add new flag
}
```

**Step 3: Add Context Check in Simulation**
```typescript
// In simulation.ts - where behavior should apply
if (vehicle.location === 'IN_LOT' && vehicle.intent === 'SEEKING_PARKING') {
  const result = this.applyNewBehavior(vehicle);
  if (result !== null) {
    // Behavior was applied
  }
}
```

**Step 4: Implement the Behavior Method**
```typescript
private applyNewBehavior(vehicle: Vehicle): SomeResult | null {
  // Guard: Only apply in correct context
  if (vehicle.state === 'PARKING') return null;

  // Implement behavior logic
  // Return null if behavior doesn't apply
}
```

#### Current Context-Behavior Mapping

| Location | Intent | Active Behaviors |
|----------|--------|------------------|
| `ON_MAIN_ROAD` | `SEEKING_PARKING` | Lane changing, cooperative yielding, lane-locked driving |
| `ON_MAIN_ROAD` | `EXITING_LOT` | Lane-locked driving (post-merge) |
| `ON_ENTRY_ROAD` | `SEEKING_PARKING` | Waypoint following, speed reduction |
| `IN_LOT` | `SEEKING_PARKING` | Obstacle avoidance, waypoint following, parked car detection |
| `IN_LOT` | `EXITING_LOT` | Reversing (from spot), waypoint following |
| `ON_EXIT_ROAD` | `EXITING_LOT` | Merge waiting, gap detection |
| `IN_SPOT` | `PARKED` | No movement (static obstacle) |

#### Future Extensibility Examples

**Example 1: Add "Pedestrian Yielding" behavior**
```typescript
// Context: IN_LOT + pedestrian detected ahead
if (vehicle.location === 'IN_LOT') {
  const pedestrianAhead = this.detectPedestrianAhead(vehicle);
  if (pedestrianAhead) {
    vehicle.behaviors.isYielding = true;
    vehicle.targetSpeed = 0;
  }
}
```

**Example 2: Add "Traffic Light Compliance" behavior**
```typescript
// Context: Approaching traffic light
if (vehicle.trafficControl.mustStop && vehicle.trafficControl.distanceToLight < 10) {
  vehicle.behaviors.isWaitingAtLight = true;
  vehicle.targetSpeed = 0;
}
```

**Example 3: Add "Narrow Aisle Passing" behavior**
```typescript
// Context: IN_LOT + oncoming vehicle in same aisle
if (vehicle.location === 'IN_LOT') {
  const oncoming = this.detectOncomingInAisle(vehicle);
  if (oncoming && this.aisleWidth < MIN_PASSING_WIDTH) {
    // One vehicle must yield
    if (this.shouldYieldTo(vehicle, oncoming)) {
      vehicle.behaviors.isYielding = true;
    }
  }
}
```

#### Design Principles for New Behaviors

1. **Context Guard First**: Always check location/intent before applying behavior
2. **Return Early if Not Applicable**: Use `return null` pattern for optional behaviors
3. **Don't Override Higher-Priority Rules**: Speed limits and collision avoidance take precedence
4. **Use Behavior Flags**: Set flags for debugging and visualization
5. **Respect Boundaries**: Check aisle/road bounds before steering
6. **Composable**: Multiple behaviors can be active simultaneously (e.g., lane changing + yielding)

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
4. Enter lot (top of lot area)
5. Move to approach point: `approachX = min(spot.x + 30, rightCorridorX)`
   - This creates different vertical paths for different spots
   - Spreads traffic instead of funneling through single corridor
6. Drive down to target aisle level
7. Turn into aisle at spot's x position
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

### Car Behavior Rules (Complete Reference)

This section documents all currently implemented car behaviors in the simulation.

> **Architecture Note:** Behaviors are context-aware and location-dependent. See
> [Context-Aware Behavior Architecture](#context-aware-behavior-architecture) for the
> extensibility pattern used to add new behaviors.

---

#### Behaviors by Location (Quick Reference)

| Location | Enabled Behaviors |
|----------|-------------------|
| `ON_MAIN_ROAD` | Lane-locked driving, lane changing, cooperative yielding, turn point detection |
| `ON_ENTRY_ROAD` | Waypoint following, speed reduction |
| `IN_LOT` | Obstacle avoidance (15° max), parked car detection, waypoint following |
| `IN_SPOT` | Static (no movement), acts as obstacle to others |
| `ON_EXIT_ROAD` | Waypoint following, merge gap detection, merge waiting |
| **All Locations** | **Movement validation, off-road recovery** |

---

#### 1. State Machine & Lifecycle

Cars progress through a defined state machine based on their intent and location:

**Entry Flow (SEEKING_PARKING intent):**
```
APPROACHING → ENTERING → NAVIGATING_TO_SPOT → PARKING → PARKED
```

**Exit Flow (EXITING_LOT intent):**
```
PARKED → EXITING_SPOT → DRIVING_TO_EXIT → IN_EXIT_LANE → AT_MERGE_POINT → MERGING → ON_ROAD → EXITED
```

| State | Description | Speed | Location |
|-------|-------------|-------|----------|
| `APPROACHING` | On main road, driving west toward entry | 13.4 m/s (30 mph) | `ON_MAIN_ROAD` |
| `ENTERING` | Turned onto entry road, driving south | 2.2 m/s (5 mph) | `ON_ENTRY_ROAD` |
| `NAVIGATING_TO_SPOT` | In lot, following path to spot | 4.5 m/s (10 mph) | `IN_LOT` |
| `PARKING` | Final approach to parking spot | 0.5 m/s (1 mph) | `IN_LOT` |
| `PARKED` | Stationary in spot, waiting | 0 | `IN_SPOT` |
| `EXITING_SPOT` | Reversing out of spot | 1.0 m/s (2 mph) | `IN_LOT` |
| `DRIVING_TO_EXIT` | Navigating through lot to exit | 4.5 m/s (10 mph) | `IN_LOT` |
| `IN_EXIT_LANE` | On exit road, driving north | 2.2 m/s (5 mph) | `ON_EXIT_ROAD` |
| `AT_MERGE_POINT` | Stopped, waiting for gap to merge | 0 | `ON_EXIT_ROAD` |
| `MERGING` | Actively merging onto main road | 3.0 m/s (7 mph) | `ON_EXIT_ROAD` |
| `ON_ROAD` | On main road after merge, accelerating | 13.4 m/s (30 mph) | `ON_MAIN_ROAD` |
| `EXITED` | Left simulation boundary | 0 | `EXITED` |

---

#### 2. Speed Control

Speed is computed as the **minimum** of multiple constraints:

```typescript
targetSpeed = min(
  stateMaxSpeed,       // Based on vehicle state (see table above)
  topologySpeedLimit,  // Based on current position (road/aisle limits)
  densityAdjustedSpeed,// Reduced in congested areas
  gapBasedSpeed,       // Safe following distance (IDM-style)
  yieldSpeed           // Cooperative yielding for lane changers
)
```

**Speed Limits by Area:**
| Area | Speed Limit | Notes |
|------|-------------|-------|
| Main Road | 13.4 m/s (30 mph) | Full highway speed |
| Entry Road | 2.2 m/s (5 mph) | Slow for turning |
| Exit Road | 2.2 m/s (5 mph) | Slow for safety |
| Aisles | 4.5 m/s (10 mph) | Moderate lot speed |
| Lot (general) | 2.2 m/s (5 mph) | Default lot speed |

**Gap-Based Speed (IDM Model):**
- Minimum gap: 2.0 m
- Safe time headway: 1.5 seconds
- At gap < 2m: creep at 0.25 m/s
- At gap < 4m: creep at 0.5 m/s
- At gap < desired: proportionally reduce speed

---

#### 3. Path Following

Cars follow pre-computed waypoint paths generated at spawn time.

**Waypoint Acceptance Radius:**
- General: 3.0 m
- Parking state: 2.5 m (tighter for precision)

**Turn Rate:** 2.0 radians/second maximum

**Main Road Special Handling:**
- Y-position is locked to current lane (not path-following)
- Only X-distance checked for waypoint completion
- Heading fixed to π (west)
- Cars continue driving west even if path is exhausted

**Turn Point Behavior:**
- When vehicle reaches entry road x-position AND is in lane 0:
  - Advances `pathIndex` to skip stale main road waypoints
  - Sets heading to `-π/2` (south) immediately
  - Prevents 360° spin from outdated waypoints

---

#### 4. Lane Changing (Main Road)

Cars must be in lane 0 (bottom/south) to turn into the entry road.

**Lane Change Parameters:**
| Parameter | Value | Description |
|-----------|-------|-------------|
| `LANE_CHANGE_MIN_GAP` | 8.0 m | Min gap ahead in target lane |
| `LANE_CHANGE_LOOK_BEHIND` | 30 m | Distance to check behind |
| `LANE_CHANGE_TIME` | 2.0 s | Duration of maneuver |
| Time-to-close threshold | 3 s | Min time before vehicle behind catches up |

**Lane Change Logic:**
1. Detect need: If not in lane 0 and within 600m of entry
2. Safety check: Verify gaps ahead (8m) and behind (30m + time-to-close)
3. Execute: Smooth ease-in-out interpolation over 2 seconds
4. Complete: Snap to target lane y-position

**Urgency Slowdown:**
- If lane change needed but blocked, and within 200m of entry:
- Speed reduced by 40% to find a gap

**Missed Turn Handling:**
- If car passes entry by >50m in wrong lane:
- Car marked as EXITED (can't turn back on one-way road)
- Assigned parking spot freed
- Replacement vehicle spawned (during FILLING phase)

---

#### 5. Parked Cars as Obstacles

**Rule:** Moving vehicles treat parked cars as solid, immovable obstacles.

**Gap Detection (`getGapAhead`):**
- Parked cars ARE included in collision detection
- Only `EXITED` vehicles are skipped
- Dot product used to determine if obstacle is ahead
- Cross product used for lateral distance check

**Collision Response:**
- When moving car collides with parked car: `v1.speed = 0`
- Parked car never moves
- Moving car must wait or find alternate path

**Congestion Exclusion:**
- Parked cars do NOT contribute to density calculations
- Only actively moving vehicles affect traffic flow metrics
- When state changes (e.g., to `EXITING_SPOT`), car rejoins congestion model

---

#### 6. Obstacle Avoidance (In Aisles)

When driving in aisles, cars can steer around parked vehicles blocking their path.

**Conditions:**
- Only in parking lot (`location === 'IN_LOT'`)
- NOT in `PARKING` state (those need direct path to spot)
- Only avoids `PARKED` state vehicles

**Detection:**
- Look ahead: 10 meters
- Path width: 1.5 × car width (2.7 m)
- Uses dot product (ahead check) and cross product (lateral distance)

**Steering:**
- Maximum avoidance angle: 15° (π/12 radians)
- Direction: Away from blocking car (cross product determines side)

**Boundary Check (Critical):**
- Before applying steering, projects future position (2 seconds ahead)
- If projection would exit aisle bounds: steering rejected
- Car instead slows down via normal gap detection
- Prevents cars from driving outside paved areas

```typescript
const projectedY = vehicle.y + Math.sin(newHeading) * vehicle.speed * 2;
if (projectedY < aisle.y - aisleHalfWidth || projectedY > aisle.y + aisleHalfWidth) {
  return null; // Don't steer outside aisle
}
```

---

#### 7. Cooperative Yielding

Cars on main road yield to vehicles changing lanes in front of them.

**Detection:**
- Looks ahead 40m for lane-changing vehicles
- Checks if other car's `targetLane` matches our `currentLane`
- Only yields to cars ahead (smaller x-position for westbound traffic)

**Response:**
- Computes safe following speed based on distance
- Maintains gap of 1.5× car length to merging vehicle
- Allows smooth lane changes without collision

---

#### 8. Merging onto Main Road

Cars at merge point (top of exit road) wait for safe gaps before merging.

**Gap Requirements:**
- Safe gap time: 3 seconds
- Safe gap distance: 3 × 13.4 m/s = 40.2 m
- Checks both road vehicles (grey) and other merging/on-road vehicles

**Merge Execution:**
- When gap found: state changes to `MERGING`
- Speed: 3.0 m/s (accelerating)
- Upon reaching main road y-position: state becomes `ON_ROAD`
- Lane assigned: 0 (bottom lane where exit road joins)

---

#### 9. Reversing (Exiting Spots)

Cars back out of parking spots without turning.

**Behavior:**
- `isReversing` flag set to true
- Movement: backward relative to heading
- No steering applied during reverse
- Speed: 1.0 m/s (backup speed)

**State Transition:**
- After reaching aisle (pathIndex >= 2): switch to forward driving
- `isReversing` set to false
- Continue to `DRIVING_TO_EXIT` state

---

#### 10. Collision Resolution

**Spatial Grid:**
- O(1) neighbor lookups using grid cells (10m × 10m)
- Only checks nearby vehicles for collisions

**Priority System:**
- Cars closer to exit have higher priority
- When collision detected: lower priority car stops
- Parked cars always have priority (never move)

**Overlap Resolution:**
- When cars overlap (dist < 0.8 × car length)
- Nudge apart slightly in direction away from each other
- Prevents permanent stuck states

---

#### 11. Wait Time Tracking

**Purpose:** Visual feedback for stuck vehicles

**Accumulation:**
- Increments when speed < 0.1 m/s
- NOT accumulated when PARKED or AT_MERGE_POINT
- Resets to 0 when vehicle starts moving again

**Visual Effect:**
- Vehicles with `waitTime > 3s` rendered in red
- Helps identify congestion points

---

#### 12. Spawning

**Staggered Spawning:**
- `spawnQueue` maintains count of vehicles to spawn
- One vehicle spawned every 0.5 seconds
- Prevents gridlock from simultaneous spawning

**Lane Distribution:**
- Vehicles biased toward lanes 0-1 (45%/40%/15% distribution)
- Must change to lane 0 before reaching entry

**Position:**
- Spawn x: right edge of main road (not beyond)
- Spawn y: lane y-position based on assigned lane

**Spawn Spacing Check:**
- Before spawning, checks if any vehicle is within 2 car lengths of spawn point
- If spawn point is blocked, spawn attempt is skipped (will retry next interval)
- Prevents pile-ups where cars spawn on top of each other

---

#### 13. Stay Within Paved Path (Boundary Constraints)

Cars must remain within the paved areas at all times. This is enforced through coordinate validation rather than position clamping.

**Coordinate Validation (`isWithinPavedArea`):**
Before any movement is applied, the new position is validated against all paved surfaces:

| Paved Area | X Bounds | Y Bounds |
|------------|----------|----------|
| Main Road | `roadLeft` to `roadRight` | `roadBottom` to `roadTop` |
| Entry Road | `entryLeft` to `entryRight` | `entryBottom` to `entryTop` |
| Exit Road | `exitLeft` to `exitRight` | `exitBottom` to `exitTop` |
| Parking Lot | `lotLeft` to `lotRight` | `lotBottom` to `lotTop` |

A position is valid if it falls within ANY of these areas. This correctly handles junctions where roads overlap (e.g., where entry road meets main road).

**Movement Validation:**
```typescript
const newX = vehicle.x + Math.cos(heading) * speed * dt;
const newY = vehicle.y + Math.sin(heading) * speed * dt;

if (this.isWithinPavedArea(newX, newY)) {
  vehicle.x = newX;
  vehicle.y = newY;
} else {
  // Try moving along each axis independently
  if (this.isWithinPavedArea(newX, vehicle.y)) vehicle.x = newX;
  if (this.isWithinPavedArea(vehicle.x, newY)) vehicle.y = newY;
}
```

**Collision Nudge Constraints:**
When collision resolution nudges cars apart, the nudge is validated:
- Before applying nudge, check if new position is within paved area
- If full nudge would push outside, try nudging along each axis independently
- Prevents collision resolution from pushing cars off roads

```typescript
if (this.isWithinPavedArea(v1NewX, v1NewY)) {
  v1.x = v1NewX;
  v1.y = v1NewY;
} else {
  // Try each axis independently
  if (this.isWithinPavedArea(v1NewX, v1.y)) v1.x = v1NewX;
  if (this.isWithinPavedArea(v1.x, v1NewY)) v1.y = v1NewY;
}
```

**Recovery Behavior (`recoverFromOffRoad`):**
If a vehicle somehow ends up outside the paved area, a recovery behavior activates:
1. Find the nearest point on any paved surface (entry road, lot, or exit road)
2. Turn toward that point
3. Move slowly (creep speed) back onto the paved area
4. Once back on paved area, normal path following resumes

This handles edge cases where numerical precision or unexpected conditions push a vehicle slightly off-road.

**Why Coordinate Validation Instead of Clamping:**
The previous clamping approach had a critical flaw: it prevented legitimate movements at road junctions. For example, a car at (171, 354) trying to turn south from the main road onto the entry road would have its y-position clamped to the main road bottom, preventing the turn.

Coordinate validation allows movement as long as the destination is on ANY valid paved surface, correctly handling transitions between roads.

---

#### 14. Summary: Behaviors Grouped by Location Context

This section organizes all behaviors by where they apply, demonstrating the context-aware architecture.

**`ON_MAIN_ROAD` Behaviors:**
| Behavior | Condition | Implementation |
|----------|-----------|----------------|
| Lane-locked driving | Always | Y-position snapped to lane center |
| Lane changing | Need lane 0, within 600m of entry | Smooth ease-in-out interpolation |
| Cooperative yielding | Another car changing into our lane | Slow down to maintain gap |
| Urgency slowdown | Can't change lanes, within 200m | Reduce speed by 40% |
| Turn point detection | At entry x-position AND in lane 0 | Face south, advance pathIndex |
| Missed turn handling | Passed entry by 50m in wrong lane | Mark EXITED, respawn replacement |

**`ON_ENTRY_ROAD` Behaviors:**
| Behavior | Condition | Implementation |
|----------|-----------|----------------|
| Waypoint following | Always | Turn toward next waypoint, move forward |
| Speed reduction | Always | Limited to 2.2 m/s (5 mph) |

**`IN_LOT` Behaviors:**
| Behavior | Condition | Implementation |
|----------|-----------|----------------|
| Obstacle avoidance | Parked car ahead, in aisle | Steer up to 15° around obstacle |
| Boundary checking | Before any steering | Project position, reject if leaves aisle |
| Parked car collision | Moving car hits parked car | Moving car stops (speed = 0) |
| Waypoint following | Not reversing | Turn toward waypoint, move forward |
| Reversing | EXITING_SPOT state | Move backward without turning |
| Direct spot approach | PARKING state, path exhausted | Turn toward spot, move forward |

**`IN_SPOT` Behaviors:**
| Behavior | Condition | Implementation |
|----------|-----------|----------------|
| Static obstacle | Always | Speed = 0, position fixed |
| Collision blocker | Moving car approaches | Moving car must stop or avoid |

**`ON_EXIT_ROAD` Behaviors:**
| Behavior | Condition | Implementation |
|----------|-----------|----------------|
| Waypoint following | IN_EXIT_LANE state | Turn toward waypoint, move forward |
| Merge waiting | AT_MERGE_POINT state | Check for gap in main road traffic |
| Merge execution | MERGING state, gap found | Accelerate onto main road |

**Universal Behaviors (All Locations):**
| Behavior | Condition | Implementation |
|----------|-----------|----------------|
| Speed limiting | Always | min(state, topology, density, gap) |
| Collision resolution | Any two cars overlap | Priority-based stopping + nudge apart |
| Wait time tracking | Speed < 0.1 m/s | Increment counter, visual feedback |
| Gap-based speed | Car ahead | IDM-style following distance |
| Movement validation | Before any position update | Check `isWithinPavedArea()`, reject if off-road |
| Off-road recovery | Position outside paved area | Find nearest paved point, navigate back slowly |

---

#### Adding a New Location-Specific Behavior

To add a behavior that only applies in a specific location:

```typescript
// 1. Check location context FIRST
if (vehicle.location !== 'IN_LOT') return null;

// 2. Check additional conditions
if (vehicle.state === 'PARKING') return null;  // Doesn't apply when parking

// 3. Detect the situation
const obstacle = this.detectObstacle(vehicle);
if (!obstacle) return null;

// 4. Apply the behavior
const newHeading = this.computeAvoidanceHeading(vehicle, obstacle);

// 5. Validate the result (respect boundaries)
if (!this.isValidHeading(vehicle, newHeading)) return null;

return newHeading;
```

This pattern ensures:
- Behaviors are isolated to their context
- Multiple behaviors can compose without conflicts
- New topologies work without behavior changes
- Debugging is easier (check location → check behavior)

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

### Version 2.7 - Direct Path Routing (Traffic Distribution)
- Fixed traffic bottleneck where all cars used the same vertical corridor path

- **Problem observed**: When cars entered the lot to park:
  1. All cars traveled to the same corridor point (`corridorX = lot.x + lot.width - 15`)
  2. All cars then traveled down the same vertical corridor
  3. When one car stopped (to pull into a spot), all cars behind got blocked
  4. This created a cascading traffic jam

- **Root cause**: The `generateEntryPath()` function used a single hardcoded corridor x-position
  for all vehicles, regardless of where their destination spot was located

- **Reason for fix**: In the real world, drivers minimize travel distance by choosing the most
  direct drivable path to their parking spot. They don't all follow the same lane when there's
  open pavement available. A driver going to a spot on the left side of the lot would naturally
  drive more toward the left, while a driver going to a spot on the right would stay right.

- **Solution**: Direct path routing that minimizes travel distance while staying on drivable paths
  - `approachX = min(spot.x + 30, rightCorridorX)` - creates unique approach point per spot
  - Cars heading to spots on the left travel further left before going down
  - Cars heading to spots on the right stay near the right corridor
  - This spreads traffic across the lot width instead of single corridor
  - When one car stops, cars with different destinations can pass on different paths

### Version 2.9 - Merge Point Improvements

- Improved merge logic to prevent cars from getting stuck when exiting the lot

- **Problems addressed**:
  1. Imprecise merge point detection could cause vehicles to overshoot
  2. Merge gap requirements were too restrictive (45m gaps)
  3. No timeout protection for vehicles waiting indefinitely at merge point
  4. MERGING state completion check was relative to road center instead of lane 0

- **Solution 1 - Precise Merge Point Detection**:
  - Calculate exact lane 0 y-position for merge point detection
  - Vehicle stops precisely at `mergePointY - 5` instead of vague `mainRoad.y - 10`
  - Explicitly stop vehicle at merge point (`vehicle.speed = 0`)

- **Solution 2 - Improved `canMerge()` Logic**:
  - Reduced gap requirements to realistic values (10m ahead, 30m behind)
  - Use time-to-reach calculation instead of fixed distance for approaching vehicles
  - Check only lane 0 conflicts, not entire road width
  - Limit concurrent merging vehicles to 2 to prevent pile-ups

- **Solution 3 - Merge Timeout Protection**:
  - After 10 seconds waiting at merge point, use relaxed `hasMinimalMergeGap()` check
  - Minimal gap check only prevents immediate collisions (1.5 car lengths)
  - Prevents indefinite waiting during high traffic periods

- **Solution 4 - Precise Merge Completion**:
  - Check against lane 0 y-position, not road center
  - Snap vehicle to lane center on merge completion
  - Set heading to west (π) for clean traffic flow

---

### Version 2.8 - Coordinate Validation & Off-Road Recovery

- Replaced position clamping with coordinate validation approach

- **Problem observed**: Cars were getting stuck at road junctions, specifically at the entry road turn:
  1. The `clampToRoadBounds()` function clamped cars to their current road's bounds
  2. When a car at the main road tried to turn south onto the entry road, its y-position was clamped to `mainRoadBottom`
  3. The car could never decrease y enough to trigger the `ON_ENTRY_ROAD` state transition
  4. Additionally, collision resolution could nudge cars outside road bounds, leaving them permanently stuck

- **Root cause**: Clamping treats the symptom (cars off-road) but prevents legitimate transitions between roads at junctions

- **Solution 1 - Coordinate Validation (`isWithinPavedArea`)**:
  - Before applying any movement, check if the new position is valid on ANY paved surface
  - A position at (167, 354) is valid because it's on the entry road, even though it's below the main road
  - Movement is allowed as long as the destination is on valid paved area
  - If full movement would go off-road, try moving along each axis independently

- **Solution 2 - Collision Nudge Validation**:
  - Before applying collision resolution nudges, validate with `isWithinPavedArea()`
  - If nudge would push vehicle off-road, reject or reduce the nudge
  - Prevents collision resolution from pushing cars outside paved areas

- **Solution 3 - Off-Road Recovery (`recoverFromOffRoad`)**:
  - If a vehicle somehow ends up outside paved area, activate recovery mode
  - Find the nearest point on any paved surface (entry road, lot, exit road)
  - Turn toward that point and move slowly (creep speed) back onto pavement
  - Once back on paved area, normal path following resumes
  - This handles edge cases from numerical precision or unexpected conditions

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
