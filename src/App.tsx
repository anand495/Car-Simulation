import { useRef, useEffect, useState, useCallback } from 'react';
import { Simulation } from './simulation';
import { createStandardLot, getWorldBounds } from './topology';
import {
  Vehicle,
  Topology,
  SimulationPhase,
  COLORS,
  CAR_LENGTH,
  CAR_WIDTH,
  DEFAULT_CONFIG,
} from './types';

// ============================================================================
// CANVAS RENDERER
// ============================================================================

interface Camera {
  x: number;
  y: number;
  zoom: number;
}

function worldToScreen(
  worldX: number,
  worldY: number,
  camera: Camera,
  canvas: HTMLCanvasElement
): { x: number; y: number } {
  const x = (worldX - camera.x) * camera.zoom + canvas.width / 2;
  const y = canvas.height / 2 - (worldY - camera.y) * camera.zoom;
  return { x, y };
}

function drawTopology(
  ctx: CanvasRenderingContext2D,
  topology: Topology,
  camera: Camera,
  canvas: HTMLCanvasElement
): void {
  const { mainRoad, entryRoad, exitRoad, lot, entryPoint, exitPoint } = topology;

  // Draw parking lot background
  const lotTopLeft = worldToScreen(lot.x, lot.y + lot.height, camera, canvas);
  const lotSize = {
    width: lot.width * camera.zoom,
    height: lot.height * camera.zoom,
  };

  ctx.fillStyle = COLORS.lot;
  ctx.fillRect(lotTopLeft.x, lotTopLeft.y, lotSize.width, lotSize.height);

  // Draw aisles
  ctx.fillStyle = COLORS.aisle;
  for (const aisle of topology.aisles) {
    const aisleStart = worldToScreen(aisle.xStart, aisle.y, camera, canvas);
    const aisleEnd = worldToScreen(aisle.xEnd, aisle.y, camera, canvas);
    const aisleHeight = 6 * camera.zoom;
    ctx.fillRect(
      aisleStart.x,
      aisleStart.y - aisleHeight / 2,
      aisleEnd.x - aisleStart.x,
      aisleHeight
    );
  }

  // Draw parking spots
  const spotW = 2.7 * camera.zoom;
  const spotH = 5.5 * camera.zoom;

  for (const spot of topology.spots) {
    const pos = worldToScreen(spot.x, spot.y, camera, canvas);
    ctx.fillStyle = spot.occupied ? COLORS.spotOccupied : COLORS.spotEmpty;
    ctx.fillRect(pos.x - spotW / 2, pos.y - spotH / 2, spotW, spotH);

    // Spot border
    ctx.strokeStyle = COLORS.roadMarkings;
    ctx.lineWidth = 1;
    ctx.strokeRect(pos.x - spotW / 2, pos.y - spotH / 2, spotW, spotH);
  }

  // Draw main road (horizontal, 3 lanes)
  const mainRoadStart = worldToScreen(mainRoad.x, mainRoad.y, camera, canvas);
  const mainRoadEnd = worldToScreen(mainRoad.x + mainRoad.length, mainRoad.y, camera, canvas);
  const mainRoadWidth = mainRoad.width * camera.zoom;

  ctx.fillStyle = COLORS.road;
  ctx.fillRect(mainRoadStart.x, mainRoadStart.y - mainRoadWidth / 2, mainRoadEnd.x - mainRoadStart.x, mainRoadWidth);

  // Main road lane markings
  ctx.strokeStyle = COLORS.roadMarkings;
  ctx.lineWidth = 2;
  ctx.setLineDash([15, 10]);
  for (let i = 1; i < mainRoad.lanes; i++) {
    const laneY = mainRoad.y - mainRoad.width / 2 + (i * mainRoad.width / mainRoad.lanes);
    const start = worldToScreen(mainRoad.x, laneY, camera, canvas);
    const end = worldToScreen(mainRoad.x + mainRoad.length, laneY, camera, canvas);
    ctx.beginPath();
    ctx.moveTo(start.x, start.y);
    ctx.lineTo(end.x, end.y);
    ctx.stroke();
  }
  ctx.setLineDash([]);

  // Draw direction arrow on main road (westbound)
  const arrowX = mainRoad.x + mainRoad.length / 2;
  const arrowPos = worldToScreen(arrowX, mainRoad.y, camera, canvas);
  ctx.fillStyle = COLORS.roadMarkings;
  ctx.beginPath();
  ctx.moveTo(arrowPos.x + 15, arrowPos.y - 8);
  ctx.lineTo(arrowPos.x - 10, arrowPos.y);
  ctx.lineTo(arrowPos.x + 15, arrowPos.y + 8);
  ctx.closePath();
  ctx.fill();

  // Draw entry road (vertical, from main road down to lot)
  const entryRoadWidth = entryRoad.width * camera.zoom;
  const entryTop = worldToScreen(entryRoad.x, mainRoad.y, camera, canvas);
  const entryBottom = worldToScreen(entryRoad.x, entryRoad.y, camera, canvas);

  ctx.fillStyle = COLORS.road;
  ctx.fillRect(
    entryTop.x - entryRoadWidth / 2,
    entryTop.y,
    entryRoadWidth,
    entryBottom.y - entryTop.y
  );

  // Entry road label
  ctx.fillStyle = '#4ade80';
  ctx.font = `${12 * camera.zoom}px sans-serif`;
  ctx.textAlign = 'center';
  const entryLabelPos = worldToScreen(entryRoad.x, entryRoad.y + entryRoad.length / 2, camera, canvas);
  ctx.fillText('IN', entryLabelPos.x, entryLabelPos.y);

  // Draw exit road (vertical, from lot up to main road)
  const exitRoadWidth = exitRoad.width * camera.zoom;
  const exitTop = worldToScreen(exitRoad.x, mainRoad.y, camera, canvas);
  const exitBottom = worldToScreen(exitRoad.x, exitRoad.y, camera, canvas);

  ctx.fillStyle = COLORS.road;
  ctx.fillRect(
    exitTop.x - exitRoadWidth / 2,
    exitTop.y,
    exitRoadWidth,
    exitBottom.y - exitTop.y
  );

  // Exit road label
  ctx.fillStyle = '#f97316';
  ctx.font = `${12 * camera.zoom}px sans-serif`;
  ctx.textAlign = 'center';
  const exitLabelPos = worldToScreen(exitRoad.x, exitRoad.y + exitRoad.length / 2, camera, canvas);
  ctx.fillText('OUT', exitLabelPos.x, exitLabelPos.y);

  // Draw entry point marker
  const entryPtPos = worldToScreen(entryPoint.x, entryPoint.y, camera, canvas);
  ctx.fillStyle = '#4ade80';
  ctx.beginPath();
  ctx.arc(entryPtPos.x, entryPtPos.y, 4 * camera.zoom, 0, Math.PI * 2);
  ctx.fill();

  // Draw exit point marker
  const exitPtPos = worldToScreen(exitPoint.x, exitPoint.y, camera, canvas);
  ctx.fillStyle = '#f97316';
  ctx.beginPath();
  ctx.arc(exitPtPos.x, exitPtPos.y, 4 * camera.zoom, 0, Math.PI * 2);
  ctx.fill();
}

function drawVehicle(
  ctx: CanvasRenderingContext2D,
  vehicle: Vehicle,
  camera: Camera,
  canvas: HTMLCanvasElement
): void {
  if (vehicle.state === 'EXITED') return;

  const pos = worldToScreen(vehicle.x, vehicle.y, camera, canvas);
  const length = CAR_LENGTH * camera.zoom;
  const width = CAR_WIDTH * camera.zoom;

  // Get color based on state
  let color = COLORS.vehicle[vehicle.state] || '#888888';

  // Highlight waiting vehicles
  if (vehicle.waitTime > 3) {
    color = COLORS.vehicleWaiting;
  }

  // Highlight lane-changing vehicles with a pulsing effect
  if (vehicle.behaviors.isChangingLane) {
    // Blend with yellow during lane change
    const pulse = Math.sin(Date.now() / 100) * 0.3 + 0.7;
    color = `rgba(255, 200, 0, ${pulse})`;
  }

  ctx.save();
  ctx.translate(pos.x, pos.y);
  ctx.rotate(-vehicle.heading); // negative because canvas y is flipped

  // Draw car body
  ctx.fillStyle = color;
  ctx.fillRect(-length / 2, -width / 2, length, width);

  // Draw front indicator
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(length / 2 - 3, -width / 4, 3, width / 2);

  // Draw turn signal indicator during lane change
  if (vehicle.behaviors.isChangingLane && vehicle.behaviors.laneChangeDirection) {
    ctx.fillStyle = '#ffcc00';
    const signalY = vehicle.behaviors.laneChangeDirection === 'right' ? width / 3 : -width / 3;
    ctx.beginPath();
    ctx.arc(-length / 4, signalY, 2 * camera.zoom, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.restore();
}

// Note: drawRoadVehicle removed - all vehicles including pass-through traffic
// are now rendered via drawVehicle as full simulation vehicles

function drawStats(
  ctx: CanvasRenderingContext2D,
  sim: Simulation,
  fps: number,
  canvas: HTMLCanvasElement
): void {
  const state = sim.state;

  // Count vehicles by state for detailed breakdown
  const stateCounts: Record<string, number> = {
    approaching: 0,
    entering: 0,
    navigating: 0,
    parking: 0,
    parked: 0,
    exiting_spot: 0,
    driving_to_exit: 0,
    in_exit_lane: 0,
    at_merge: 0,
    merging: 0,
    on_road: 0,
    stuck: 0, // waitTime > 5s
  };

  for (const v of state.vehicles) {
    if (v.state === 'APPROACHING') stateCounts.approaching++;
    else if (v.state === 'ENTERING') stateCounts.entering++;
    else if (v.state === 'NAVIGATING_TO_SPOT') stateCounts.navigating++;
    else if (v.state === 'PARKING') stateCounts.parking++;
    else if (v.state === 'PARKED') stateCounts.parked++;
    else if (v.state === 'EXITING_SPOT') stateCounts.exiting_spot++;
    else if (v.state === 'DRIVING_TO_EXIT') stateCounts.driving_to_exit++;
    else if (v.state === 'IN_EXIT_LANE') stateCounts.in_exit_lane++;
    else if (v.state === 'AT_MERGE_POINT') stateCounts.at_merge++;
    else if (v.state === 'MERGING') stateCounts.merging++;
    else if (v.state === 'ON_ROAD') stateCounts.on_road++;

    if (v.waitTime > 5 && v.state !== 'PARKED') stateCounts.stuck++;
  }

  // Calculate in-lot vehicles (navigating + parking)
  const inLot = stateCounts.navigating + stateCounts.parking;
  const inTransit = stateCounts.approaching + stateCounts.entering;
  const exitingLot = stateCounts.exiting_spot + stateCounts.driving_to_exit +
                     stateCounts.in_exit_lane + stateCounts.at_merge + stateCounts.merging;

  // Draw panel in TOP-RIGHT corner (more visible)
  const panelWidth = 220;
  const panelHeight = 240;
  const panelX = canvas.width - panelWidth - 10;
  const panelY = 10;

  ctx.fillStyle = 'rgba(0, 0, 0, 0.85)';
  ctx.fillRect(panelX, panelY, panelWidth, panelHeight);
  ctx.strokeStyle = '#444';
  ctx.lineWidth = 1;
  ctx.strokeRect(panelX, panelY, panelWidth, panelHeight);

  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 14px monospace';
  ctx.fillText('SIMULATION METRICS', panelX + 10, panelY + 20);

  ctx.font = '12px monospace';
  let y = panelY + 40;
  const lineHeight = 16;

  // Time and phase
  ctx.fillStyle = '#888';
  ctx.fillText(`Time: ${state.time.toFixed(1)}s | FPS: ${fps.toFixed(0)}`, panelX + 10, y);
  y += lineHeight;
  ctx.fillStyle = state.phase === 'FILLING' ? '#4ade80' : state.phase === 'EXODUS' ? '#f97316' : '#fff';
  ctx.fillText(`Phase: ${state.phase}`, panelX + 10, y);
  y += lineHeight + 5;

  // Main counts with colors
  ctx.fillStyle = '#4ade80';
  ctx.fillText(`Spawned: ${state.totalSpawned}`, panelX + 10, y);
  y += lineHeight;
  ctx.fillStyle = '#22d3ee';
  ctx.fillText(`Parked:  ${state.parkedCount}`, panelX + 10, y);
  y += lineHeight;
  ctx.fillStyle = '#a78bfa';
  ctx.fillText(`Exited:  ${state.exitedCount}`, panelX + 10, y);
  y += lineHeight + 5;

  // Vehicle breakdown
  ctx.fillStyle = '#888';
  ctx.fillText('--- Vehicle Status ---', panelX + 10, y);
  y += lineHeight;
  ctx.fillStyle = '#f59e0b';
  ctx.fillText(`In Transit: ${inTransit}`, panelX + 10, y);
  ctx.fillText(`(app:${stateCounts.approaching} ent:${stateCounts.entering})`, panelX + 100, y);
  y += lineHeight;
  ctx.fillStyle = '#10b981';
  ctx.fillText(`In Lot:     ${inLot}`, panelX + 10, y);
  ctx.fillText(`(nav:${stateCounts.navigating} park:${stateCounts.parking})`, panelX + 100, y);
  y += lineHeight;
  ctx.fillStyle = '#f97316';
  ctx.fillText(`Exiting:    ${exitingLot}`, panelX + 10, y);
  y += lineHeight;
  ctx.fillStyle = '#3b82f6';
  ctx.fillText(`On Road:    ${stateCounts.on_road}`, panelX + 10, y);
  y += lineHeight;

  // Stuck vehicles (highlighted in red if any)
  if (stateCounts.stuck > 0) {
    ctx.fillStyle = '#ef4444';
    ctx.font = 'bold 12px monospace';
  } else {
    ctx.fillStyle = '#22c55e';
  }
  ctx.fillText(`Stuck (>5s): ${stateCounts.stuck}`, panelX + 10, y);
  ctx.font = '12px monospace';
  y += lineHeight + 5;

  // Throughput
  ctx.fillStyle = '#888';
  ctx.fillText(`Throughput: ${state.throughput}/min`, panelX + 10, y);
}

function render(
  canvas: HTMLCanvasElement,
  sim: Simulation,
  camera: Camera,
  fps: number
): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  // Clear
  ctx.fillStyle = COLORS.background;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Draw topology
  drawTopology(ctx, sim.topology, camera, canvas);

  // Draw all vehicles (including pass-through traffic - no more separate grey cars)
  for (const vehicle of sim.state.vehicles) {
    drawVehicle(ctx, vehicle, camera, canvas);
  }

  // Draw stats overlay
  drawStats(ctx, sim, fps, canvas);
}

// ============================================================================
// MAIN APP COMPONENT
// ============================================================================

interface Stats {
  time: number;
  phase: SimulationPhase;
  spawned: number;
  parked: number;
  exited: number;
  throughput: number;
  avgExitTime: number | null;
}

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const simRef = useRef<Simulation | null>(null);
  const cameraRef = useRef<Camera>({ x: 150, y: 200, zoom: 2 });
  const fpsRef = useRef(60);

  const [stats, setStats] = useState<Stats>({
    time: 0,
    phase: 'IDLE',
    spawned: 0,
    parked: 0,
    exited: 0,
    throughput: 0,
    avgExitTime: null,
  });

  const [vehicleCount, setVehicleCount] = useState(100);
  const [speed, setSpeed] = useState(1);
  const [isPaused, setIsPaused] = useState(false);

  // Initialize simulation
  useEffect(() => {
    const topology = createStandardLot(DEFAULT_CONFIG.numSpots);
    simRef.current = new Simulation(topology, DEFAULT_CONFIG);

    // Center camera on lot
    const bounds = getWorldBounds(topology);
    cameraRef.current = {
      x: (bounds.minX + bounds.maxX) / 2,
      y: (bounds.minY + bounds.maxY) / 2,
      zoom: 1.5,
    };
  }, []);

  // Animation loop
  useEffect(() => {
    let animationId: number;
    let lastTime = performance.now();
    let frameCount = 0;
    let lastFpsUpdate = performance.now();
    let lastStatsUpdate = 0;

    const loop = (currentTime: number) => {
      const dt = (currentTime - lastTime) / 1000;
      lastTime = currentTime;

      // FPS calculation
      frameCount++;
      if (currentTime - lastFpsUpdate > 1000) {
        fpsRef.current = frameCount;
        frameCount = 0;
        lastFpsUpdate = currentTime;
      }

      const sim = simRef.current;
      const canvas = canvasRef.current;

      if (sim && canvas && !isPaused) {
        // Step simulation (with speed multiplier)
        const simDt = Math.min(dt * speed, 0.1); // cap to prevent instability
        sim.step(simDt);

        // Render
        render(canvas, sim, cameraRef.current, fpsRef.current);

        // Update React state (throttled to 10Hz)
        if (currentTime - lastStatsUpdate > 100) {
          setStats({
            time: sim.state.time,
            phase: sim.state.phase,
            spawned: sim.state.totalSpawned,
            parked: sim.state.parkedCount,
            exited: sim.state.exitedCount,
            throughput: sim.state.throughput,
            avgExitTime: sim.state.avgExitTime,
          });
          lastStatsUpdate = currentTime;
        }
      } else if (sim && canvas) {
        // Still render when paused
        render(canvas, sim, cameraRef.current, fpsRef.current);
      }

      animationId = requestAnimationFrame(loop);
    };

    animationId = requestAnimationFrame(loop);

    return () => cancelAnimationFrame(animationId);
  }, [isPaused, speed]);

  // Mouse drag for camera pan
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let isDragging = false;
    let lastX = 0;
    let lastY = 0;

    const handleMouseDown = (e: MouseEvent) => {
      isDragging = true;
      lastX = e.clientX;
      lastY = e.clientY;
    };

    const handleMouseMove = (e: MouseEvent) => {
      if (!isDragging) return;

      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;

      cameraRef.current.x -= dx / cameraRef.current.zoom;
      cameraRef.current.y += dy / cameraRef.current.zoom;

      lastX = e.clientX;
      lastY = e.clientY;
    };

    const handleMouseUp = () => {
      isDragging = false;
    };

    const handleWheel = (e: WheelEvent) => {
      e.preventDefault();
      const zoomFactor = e.deltaY > 0 ? 0.9 : 1.1;
      cameraRef.current.zoom *= zoomFactor;
      cameraRef.current.zoom = Math.max(0.5, Math.min(10, cameraRef.current.zoom));
    };

    canvas.addEventListener('mousedown', handleMouseDown);
    canvas.addEventListener('mousemove', handleMouseMove);
    canvas.addEventListener('mouseup', handleMouseUp);
    canvas.addEventListener('mouseleave', handleMouseUp);
    canvas.addEventListener('wheel', handleWheel);

    return () => {
      canvas.removeEventListener('mousedown', handleMouseDown);
      canvas.removeEventListener('mousemove', handleMouseMove);
      canvas.removeEventListener('mouseup', handleMouseUp);
      canvas.removeEventListener('mouseleave', handleMouseUp);
      canvas.removeEventListener('wheel', handleWheel);
    };
  }, []);

  // Control handlers
  const handleFillLot = useCallback(() => {
    if (simRef.current) {
      simRef.current.fillLot(vehicleCount);
    }
  }, [vehicleCount]);

  const handleStartExodus = useCallback(() => {
    if (simRef.current) {
      simRef.current.startExodus();
    }
  }, []);

  const handleReset = useCallback(() => {
    if (simRef.current) {
      simRef.current.reset();
      setStats({
        time: 0,
        phase: 'IDLE',
        spawned: 0,
        parked: 0,
        exited: 0,
        throughput: 0,
        avgExitTime: null,
      });
    }
  }, []);

  const handleExportLog = useCallback(() => {
    if (simRef.current) {
      const logJson = simRef.current.exportLog();
      const blob = new Blob([logJson], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `simulation-log-${new Date().toISOString().slice(0, 19)}.json`;
      a.click();
      URL.revokeObjectURL(url);

      // Also log summary to console
      const summary = simRef.current.getLogSummary();
      console.log('=== Simulation Log Summary ===');
      console.log(`Duration: ${summary.duration.toFixed(1)}s`);
      console.log(`Vehicles: ${summary.vehicleCount}`);
      console.log(`Snapshots: ${summary.totalSnapshots}`);
      console.log(`Events: ${summary.totalEvents}`);
      if (summary.stuckVehicles.length > 0) {
        console.log('Stuck vehicles (wait > 5s):');
        summary.stuckVehicles.forEach(v => {
          console.log(`  - Vehicle ${v.id}: ${v.maxWaitTime.toFixed(1)}s stuck in ${v.lastState}`);
        });
      }
    }
  }, []);

  const handlePauseToggle = useCallback(() => {
    setIsPaused((p) => !p);
  }, []);

  return (
    <div style={styles.container}>
      <canvas
        ref={canvasRef}
        width={1200}
        height={700}
        style={styles.canvas}
      />

      <div style={styles.controls}>
        <div style={styles.controlGroup}>
          <label style={styles.label}>
            Vehicles: {vehicleCount}
            <input
              type="range"
              min="10"
              max="500"
              value={vehicleCount}
              onChange={(e) => setVehicleCount(parseInt(e.target.value))}
              style={styles.slider}
            />
          </label>
        </div>

        <div style={styles.controlGroup}>
          <label style={styles.label}>
            Speed: {speed}x
            <input
              type="range"
              min="0.1"
              max="10"
              step="0.1"
              value={speed}
              onChange={(e) => setSpeed(parseFloat(e.target.value))}
              style={styles.slider}
            />
          </label>
        </div>

        <div style={styles.buttonGroup}>
          <button onClick={handleFillLot} style={styles.button}>
            Fill Lot
          </button>
          <button onClick={handleStartExodus} style={styles.buttonOrange}>
            Start Exodus
          </button>
          <button onClick={handlePauseToggle} style={styles.buttonGray}>
            {isPaused ? 'Resume' : 'Pause'}
          </button>
          <button onClick={handleReset} style={styles.buttonRed}>
            Reset
          </button>
          <button onClick={handleExportLog} style={styles.buttonBlue}>
            Export Log
          </button>
        </div>

        <div style={styles.statsPanel}>
          <div>Phase: <strong>{stats.phase}</strong></div>
          <div>Time: {stats.time.toFixed(1)}s</div>
          <div>Parked: {stats.parked} | Exited: {stats.exited}</div>
          <div>Throughput: {stats.throughput}/min</div>
          {stats.avgExitTime !== null && (
            <div>Avg Exit Time: {stats.avgExitTime.toFixed(1)}s</div>
          )}
        </div>
      </div>

      <div style={styles.instructions}>
        Drag to pan | Scroll to zoom | Fill lot, then start exodus to simulate
      </div>
    </div>
  );
}

// ============================================================================
// STYLES
// ============================================================================

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    padding: '10px',
    gap: '10px',
  },
  canvas: {
    border: '2px solid #333',
    borderRadius: '4px',
    cursor: 'grab',
  },
  controls: {
    display: 'flex',
    gap: '20px',
    alignItems: 'center',
    flexWrap: 'wrap',
    justifyContent: 'center',
  },
  controlGroup: {
    display: 'flex',
    flexDirection: 'column',
    gap: '5px',
  },
  label: {
    display: 'flex',
    flexDirection: 'column',
    gap: '5px',
    fontSize: '14px',
  },
  slider: {
    width: '150px',
  },
  buttonGroup: {
    display: 'flex',
    gap: '10px',
  },
  button: {
    padding: '10px 20px',
    fontSize: '14px',
    fontWeight: 'bold',
    border: 'none',
    borderRadius: '4px',
    cursor: 'pointer',
    backgroundColor: '#4ade80',
    color: '#000',
  },
  buttonOrange: {
    padding: '10px 20px',
    fontSize: '14px',
    fontWeight: 'bold',
    border: 'none',
    borderRadius: '4px',
    cursor: 'pointer',
    backgroundColor: '#f97316',
    color: '#fff',
  },
  buttonGray: {
    padding: '10px 20px',
    fontSize: '14px',
    fontWeight: 'bold',
    border: 'none',
    borderRadius: '4px',
    cursor: 'pointer',
    backgroundColor: '#666',
    color: '#fff',
  },
  buttonRed: {
    padding: '10px 20px',
    fontSize: '14px',
    fontWeight: 'bold',
    border: 'none',
    borderRadius: '4px',
    cursor: 'pointer',
    backgroundColor: '#ef4444',
    color: '#fff',
  },
  buttonBlue: {
    padding: '10px 20px',
    fontSize: '14px',
    fontWeight: 'bold',
    border: 'none',
    borderRadius: '4px',
    cursor: 'pointer',
    backgroundColor: '#3b82f6',
    color: '#fff',
  },
  statsPanel: {
    padding: '10px 15px',
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    borderRadius: '4px',
    fontSize: '13px',
    lineHeight: '1.6',
  },
  instructions: {
    fontSize: '12px',
    color: '#888',
  },
};
