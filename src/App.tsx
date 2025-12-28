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
  SimConfig,
  IDM,
  MOBIL,
} from './types';

// ============================================================================
// SETTINGS TYPES
// ============================================================================

interface SimulationSettings {
  // Topology
  topology: 'standard' | 'compact' | 'large';
  numSpots: number;

  // Traffic Model
  useIdmMobil: boolean;

  // IDM Parameters (highway)
  idmTimeHeadway: number;
  idmMinGap: number;
  idmAcceleration: number;
  idmDeceleration: number;

  // MOBIL Parameters
  mobilPoliteness: number;
  mobilThreshold: number;
  mobilSafeBraking: number;

  // Traffic
  roadTrafficRate: number;
  staggerExitSeconds: number;
}

const DEFAULT_SETTINGS: SimulationSettings = {
  topology: 'standard',
  numSpots: 500,
  useIdmMobil: true,
  idmTimeHeadway: IDM.T,
  idmMinGap: IDM.s0,
  idmAcceleration: IDM.a,
  idmDeceleration: IDM.b,
  mobilPoliteness: MOBIL.p,
  mobilThreshold: MOBIL.athreshold,
  mobilSafeBraking: MOBIL.bsafe,
  roadTrafficRate: 30,
  staggerExitSeconds: 60,
};

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
  canvas: HTMLCanvasElement,
  realTime: number = 0
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
  const panelHeight = 256;  // Increased for real time display
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
  ctx.fillText(`Sim: ${state.time.toFixed(1)}s | Real: ${realTime.toFixed(1)}s`, panelX + 10, y);
  y += lineHeight;
  ctx.fillText(`FPS: ${fps.toFixed(0)} | Speed: ${realTime > 0 ? (state.time / realTime).toFixed(1) : '0.0'}x`, panelX + 10, y);
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
  fps: number,
  realTime: number = 0
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
  drawStats(ctx, sim, fps, canvas, realTime);
}

// ============================================================================
// SETTINGS PANEL COMPONENT
// ============================================================================

interface SettingsPanelProps {
  settings: SimulationSettings;
  onChange: (settings: SimulationSettings) => void;
  onApply: () => void;
  disabled: boolean;
}

function SettingsPanel({ settings, onChange, onApply, disabled }: SettingsPanelProps) {
  const [isExpanded, setIsExpanded] = useState(true);

  const updateSetting = <K extends keyof SimulationSettings>(
    key: K,
    value: SimulationSettings[K]
  ) => {
    onChange({ ...settings, [key]: value });
  };

  return (
    <div style={styles.settingsPanel}>
      <div
        style={styles.settingsHeader}
        onClick={() => setIsExpanded(!isExpanded)}
      >
        <span style={styles.settingsIcon}>{isExpanded ? '▼' : '▶'}</span>
        <span style={styles.settingsTitle}>Settings</span>
      </div>

      {isExpanded && (
        <div style={styles.settingsContent}>
          {/* Topology Section */}
          <div style={styles.settingsSection}>
            <div style={styles.sectionTitle}>Topology</div>
            <div style={styles.settingRow}>
              <label style={styles.settingLabel}>Layout</label>
              <select
                style={styles.select}
                value={settings.topology}
                onChange={(e) => updateSetting('topology', e.target.value as SimulationSettings['topology'])}
                disabled={disabled}
              >
                <option value="standard">Standard Lot</option>
                <option value="compact" disabled>Compact (Coming Soon)</option>
                <option value="large" disabled>Large (Coming Soon)</option>
              </select>
            </div>
            <div style={styles.settingRow}>
              <label style={styles.settingLabel}>Parking Spots</label>
              <input
                type="number"
                style={styles.numberInput}
                value={settings.numSpots}
                onChange={(e) => updateSetting('numSpots', parseInt(e.target.value) || 100)}
                min={50}
                max={1000}
                disabled={disabled}
              />
            </div>
          </div>

          {/* Traffic Model Section */}
          <div style={styles.settingsSection}>
            <div style={styles.sectionTitle}>Traffic Model</div>
            <div style={styles.settingRow}>
              <label style={styles.settingLabel}>Use IDM/MOBIL</label>
              <label className="toggle-switch">
                <input
                  type="checkbox"
                  checked={settings.useIdmMobil}
                  onChange={(e) => updateSetting('useIdmMobil', e.target.checked)}
                  disabled={disabled}
                />
                <span className="toggle-slider"></span>
              </label>
            </div>
          </div>

          {/* IDM Parameters Section */}
          {settings.useIdmMobil && (
            <div style={styles.settingsSection}>
              <div style={styles.sectionTitle}>IDM Parameters</div>
              <div style={styles.settingRow}>
                <label style={styles.settingLabel}>Time Headway (s)</label>
                <input
                  type="number"
                  style={styles.numberInput}
                  value={settings.idmTimeHeadway}
                  onChange={(e) => updateSetting('idmTimeHeadway', parseFloat(e.target.value) || 1.5)}
                  min={0.5}
                  max={3}
                  step={0.1}
                  disabled={disabled}
                />
              </div>
              <div style={styles.settingRow}>
                <label style={styles.settingLabel}>Min Gap (m)</label>
                <input
                  type="number"
                  style={styles.numberInput}
                  value={settings.idmMinGap}
                  onChange={(e) => updateSetting('idmMinGap', parseFloat(e.target.value) || 2)}
                  min={1}
                  max={5}
                  step={0.5}
                  disabled={disabled}
                />
              </div>
              <div style={styles.settingRow}>
                <label style={styles.settingLabel}>Acceleration (m/s²)</label>
                <input
                  type="number"
                  style={styles.numberInput}
                  value={settings.idmAcceleration}
                  onChange={(e) => updateSetting('idmAcceleration', parseFloat(e.target.value) || 2.5)}
                  min={1}
                  max={4}
                  step={0.5}
                  disabled={disabled}
                />
              </div>
              <div style={styles.settingRow}>
                <label style={styles.settingLabel}>Deceleration (m/s²)</label>
                <input
                  type="number"
                  style={styles.numberInput}
                  value={settings.idmDeceleration}
                  onChange={(e) => updateSetting('idmDeceleration', parseFloat(e.target.value) || 4)}
                  min={2}
                  max={6}
                  step={0.5}
                  disabled={disabled}
                />
              </div>
            </div>
          )}

          {/* MOBIL Parameters Section */}
          {settings.useIdmMobil && (
            <div style={styles.settingsSection}>
              <div style={styles.sectionTitle}>MOBIL Parameters</div>
              <div style={styles.settingRow}>
                <label style={styles.settingLabel}>Politeness</label>
                <input
                  type="range"
                  style={styles.rangeInput}
                  value={settings.mobilPoliteness}
                  onChange={(e) => updateSetting('mobilPoliteness', parseFloat(e.target.value))}
                  min={0}
                  max={1}
                  step={0.1}
                  disabled={disabled}
                />
                <span style={styles.rangeValue}>{settings.mobilPoliteness.toFixed(1)}</span>
              </div>
              <div style={styles.settingRow}>
                <label style={styles.settingLabel}>Threshold (m/s²)</label>
                <input
                  type="number"
                  style={styles.numberInput}
                  value={settings.mobilThreshold}
                  onChange={(e) => updateSetting('mobilThreshold', parseFloat(e.target.value) || 0.2)}
                  min={0}
                  max={1}
                  step={0.1}
                  disabled={disabled}
                />
              </div>
              <div style={styles.settingRow}>
                <label style={styles.settingLabel}>Safe Braking (m/s²)</label>
                <input
                  type="number"
                  style={styles.numberInput}
                  value={settings.mobilSafeBraking}
                  onChange={(e) => updateSetting('mobilSafeBraking', parseFloat(e.target.value) || 4)}
                  min={2}
                  max={8}
                  step={0.5}
                  disabled={disabled}
                />
              </div>
            </div>
          )}

          {/* Traffic Section */}
          <div style={styles.settingsSection}>
            <div style={styles.sectionTitle}>Traffic</div>
            <div style={styles.settingRow}>
              <label style={styles.settingLabel}>Road Traffic (veh/min)</label>
              <input
                type="number"
                style={styles.numberInput}
                value={settings.roadTrafficRate}
                onChange={(e) => updateSetting('roadTrafficRate', parseInt(e.target.value) || 30)}
                min={0}
                max={120}
                disabled={disabled}
              />
            </div>
            <div style={styles.settingRow}>
              <label style={styles.settingLabel}>Exit Stagger (s)</label>
              <input
                type="number"
                style={styles.numberInput}
                value={settings.staggerExitSeconds}
                onChange={(e) => updateSetting('staggerExitSeconds', parseInt(e.target.value) || 60)}
                min={0}
                max={300}
                disabled={disabled}
              />
            </div>
          </div>

          <button
            style={{
              ...styles.applyButton,
              opacity: disabled ? 0.5 : 1,
              cursor: disabled ? 'not-allowed' : 'pointer',
            }}
            onClick={onApply}
            disabled={disabled}
          >
            Apply & Reset
          </button>
        </div>
      )}
    </div>
  );
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
  realTime: number;  // Real elapsed time in seconds
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
    realTime: 0,
  });

  // Track when simulation started (real time)
  const simStartTimeRef = useRef<number | null>(null);

  const [vehicleCount, setVehicleCount] = useState(100);
  const [speed, setSpeed] = useState(1);
  const [isPaused, setIsPaused] = useState(false);
  const [settings, setSettings] = useState<SimulationSettings>(DEFAULT_SETTINGS);
  const [showSettings, setShowSettings] = useState(true);

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

      // Calculate real elapsed time
      let realElapsed = 0;
      if (simStartTimeRef.current !== null) {
        realElapsed = (currentTime - simStartTimeRef.current) / 1000;
      }

      if (sim && canvas && !isPaused) {
        // Step simulation (with speed multiplier)
        const simDt = Math.min(dt * speed, 0.1); // cap to prevent instability
        sim.step(simDt);

        // Render
        render(canvas, sim, cameraRef.current, fpsRef.current, realElapsed);

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
            realTime: realElapsed,
          });
          lastStatsUpdate = currentTime;
        }
      } else if (sim && canvas) {
        // Still render when paused
        render(canvas, sim, cameraRef.current, fpsRef.current, realElapsed);
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
      // Start tracking real time when simulation begins
      if (simStartTimeRef.current === null) {
        simStartTimeRef.current = performance.now();
      }
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
      simStartTimeRef.current = null;  // Reset real time tracking
      setStats({
        time: 0,
        phase: 'IDLE',
        spawned: 0,
        parked: 0,
        exited: 0,
        throughput: 0,
        avgExitTime: null,
        realTime: 0,
      });
    }
  }, []);

  const handleExportLog = useCallback(() => {
    if (simRef.current) {
      try {
        const logJson = simRef.current.exportLog();
        const blob = new Blob([logJson], { type: 'application/json' });
        const url = URL.createObjectURL(blob);

        // Create download link
        const a = document.createElement('a');
        a.style.display = 'none';
        a.href = url;
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        a.download = `simulation-log-${timestamp}.json`;

        // Append to body, click, and remove
        document.body.appendChild(a);
        a.click();

        // Clean up after a short delay
        setTimeout(() => {
          document.body.removeChild(a);
          URL.revokeObjectURL(url);
        }, 100);

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
        console.log('Export initiated successfully!');
      } catch (error) {
        console.error('Export failed:', error);
        alert('Export failed. Check console for details.');
      }
    } else {
      console.warn('No simulation to export');
    }
  }, []);

  const handlePauseToggle = useCallback(() => {
    setIsPaused((p) => !p);
  }, []);

  const handleApplySettings = useCallback(() => {
    // Create new topology and simulation with updated settings
    const topology = createStandardLot(settings.numSpots);
    const config: SimConfig = {
      ...DEFAULT_CONFIG,
      numSpots: settings.numSpots,
      roadTrafficRate: settings.roadTrafficRate,
      staggerExitSeconds: settings.staggerExitSeconds,
    };

    simRef.current = new Simulation(topology, config);

    // Center camera on lot
    const bounds = getWorldBounds(topology);
    cameraRef.current = {
      x: (bounds.minX + bounds.maxX) / 2,
      y: (bounds.minY + bounds.maxY) / 2,
      zoom: 1.5,
    };

    // Reset stats and real time tracking
    simStartTimeRef.current = null;
    setStats({
      time: 0,
      phase: 'IDLE',
      spawned: 0,
      parked: 0,
      exited: 0,
      throughput: 0,
      avgExitTime: null,
      realTime: 0,
    });
  }, [settings]);

  const isRunning = stats.phase !== 'IDLE' && stats.phase !== 'COMPLETE';

  return (
    <div style={styles.appContainer}>
      {/* Header */}
      <header style={styles.header}>
        <div style={styles.headerLeft}>
          <h1 style={styles.logo}>Parking Flow Simulator</h1>
          <span style={styles.version}>v3.4.0</span>
        </div>
        <div style={styles.headerRight}>
          <button
            onClick={() => setShowSettings(!showSettings)}
            style={styles.headerButton}
          >
            {showSettings ? 'Hide Settings' : 'Show Settings'}
          </button>
        </div>
      </header>

      <div style={styles.mainContent}>
        {/* Settings Sidebar */}
        {showSettings && (
          <aside style={styles.sidebar}>
            <SettingsPanel
              settings={settings}
              onChange={setSettings}
              onApply={handleApplySettings}
              disabled={isRunning}
            />
          </aside>
        )}

        {/* Main Canvas Area */}
        <main style={styles.canvasArea}>
          <div style={styles.canvasWrapper}>
            <canvas
              ref={canvasRef}
              width={1200}
              height={700}
              style={styles.canvas}
            />
          </div>

          {/* Control Bar */}
          <div style={styles.controlBar}>
            <div style={styles.controlSection}>
              <label style={styles.controlLabel}>Vehicles</label>
              <input
                type="range"
                min="10"
                max="500"
                value={vehicleCount}
                onChange={(e) => setVehicleCount(parseInt(e.target.value))}
                style={styles.slider}
              />
              <span style={styles.controlValue}>{vehicleCount}</span>
            </div>

            <div style={styles.controlSection}>
              <label style={styles.controlLabel}>Speed</label>
              <input
                type="range"
                min="0.1"
                max="10"
                step="0.1"
                value={speed}
                onChange={(e) => setSpeed(parseFloat(e.target.value))}
                style={styles.slider}
              />
              <span style={styles.controlValue}>{speed.toFixed(1)}x</span>
            </div>

            <div style={styles.buttonGroup}>
              <button onClick={handleFillLot} style={styles.buttonPrimary}>
                Fill Lot
              </button>
              <button onClick={handleStartExodus} style={styles.buttonWarning}>
                Start Exodus
              </button>
              <button onClick={handlePauseToggle} style={styles.buttonSecondary}>
                {isPaused ? 'Resume' : 'Pause'}
              </button>
              <button onClick={handleReset} style={styles.buttonDanger}>
                Reset
              </button>
              <button onClick={handleExportLog} style={styles.buttonInfo}>
                Export
              </button>
            </div>
          </div>

          {/* Status Bar */}
          <div style={styles.statusBar}>
            <div style={styles.statusItem}>
              <span style={styles.statusLabel}>Phase</span>
              <span style={{
                ...styles.statusValue,
                color: stats.phase === 'FILLING' ? '#4ade80' :
                       stats.phase === 'EXODUS' ? '#f97316' :
                       stats.phase === 'COMPLETE' ? '#a78bfa' : '#888'
              }}>{stats.phase}</span>
            </div>
            <div style={styles.statusDivider} />
            <div style={styles.statusItem}>
              <span style={styles.statusLabel}>Sim Time</span>
              <span style={styles.statusValue}>{stats.time.toFixed(1)}s</span>
            </div>
            <div style={styles.statusDivider} />
            <div style={styles.statusItem}>
              <span style={styles.statusLabel}>Real Time</span>
              <span style={styles.statusValue}>{stats.realTime.toFixed(1)}s</span>
            </div>
            <div style={styles.statusDivider} />
            <div style={styles.statusItem}>
              <span style={styles.statusLabel}>Parked</span>
              <span style={styles.statusValue}>{stats.parked}</span>
            </div>
            <div style={styles.statusDivider} />
            <div style={styles.statusItem}>
              <span style={styles.statusLabel}>Exited</span>
              <span style={styles.statusValue}>{stats.exited}</span>
            </div>
            <div style={styles.statusDivider} />
            <div style={styles.statusItem}>
              <span style={styles.statusLabel}>Throughput</span>
              <span style={styles.statusValue}>{stats.throughput}/min</span>
            </div>
            {stats.avgExitTime !== null && (
              <>
                <div style={styles.statusDivider} />
                <div style={styles.statusItem}>
                  <span style={styles.statusLabel}>Avg Exit</span>
                  <span style={styles.statusValue}>{stats.avgExitTime.toFixed(1)}s</span>
                </div>
              </>
            )}
            <div style={{ flex: 1 }} />
            <div style={styles.statusHint}>
              Drag to pan | Scroll to zoom
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}

// ============================================================================
// STYLES
// ============================================================================

const styles: Record<string, React.CSSProperties> = {
  // App Layout
  appContainer: {
    display: 'flex',
    flexDirection: 'column',
    height: '100vh',
    backgroundColor: '#0f0f1a',
    color: '#e0e0e0',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  },

  // Header
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '12px 20px',
    backgroundColor: '#1a1a2e',
    borderBottom: '1px solid #2d2d44',
  },
  headerLeft: {
    display: 'flex',
    alignItems: 'baseline',
    gap: '12px',
  },
  logo: {
    margin: 0,
    fontSize: '20px',
    fontWeight: 600,
    color: '#fff',
    letterSpacing: '-0.5px',
  },
  version: {
    fontSize: '12px',
    color: '#666',
    fontWeight: 500,
  },
  headerRight: {
    display: 'flex',
    gap: '10px',
  },
  headerButton: {
    padding: '8px 16px',
    fontSize: '13px',
    fontWeight: 500,
    border: '1px solid #3d3d5c',
    borderRadius: '6px',
    cursor: 'pointer',
    backgroundColor: 'transparent',
    color: '#a0a0b0',
    transition: 'all 0.2s',
  },

  // Main Content
  mainContent: {
    display: 'flex',
    flex: 1,
    overflow: 'hidden',
  },

  // Sidebar
  sidebar: {
    width: '280px',
    backgroundColor: '#1a1a2e',
    borderRight: '1px solid #2d2d44',
    overflowY: 'auto',
  },

  // Settings Panel
  settingsPanel: {
    padding: '0',
  },
  settingsHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '16px',
    cursor: 'pointer',
    borderBottom: '1px solid #2d2d44',
    userSelect: 'none',
  },
  settingsIcon: {
    fontSize: '10px',
    color: '#666',
  },
  settingsTitle: {
    fontSize: '13px',
    fontWeight: 600,
    color: '#fff',
    textTransform: 'uppercase',
    letterSpacing: '0.5px',
  },
  settingsContent: {
    padding: '12px 16px',
  },
  settingsSection: {
    marginBottom: '20px',
  },
  sectionTitle: {
    fontSize: '11px',
    fontWeight: 600,
    color: '#888',
    textTransform: 'uppercase',
    letterSpacing: '0.5px',
    marginBottom: '12px',
  },
  settingRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: '10px',
  },
  settingLabel: {
    fontSize: '13px',
    color: '#a0a0b0',
  },
  select: {
    padding: '6px 10px',
    fontSize: '13px',
    backgroundColor: '#252538',
    border: '1px solid #3d3d5c',
    borderRadius: '4px',
    color: '#e0e0e0',
    cursor: 'pointer',
    minWidth: '120px',
  },
  numberInput: {
    padding: '6px 10px',
    fontSize: '13px',
    backgroundColor: '#252538',
    border: '1px solid #3d3d5c',
    borderRadius: '4px',
    color: '#e0e0e0',
    width: '80px',
    textAlign: 'right' as const,
  },
  rangeInput: {
    width: '80px',
    cursor: 'pointer',
  },
  rangeValue: {
    fontSize: '12px',
    color: '#888',
    width: '30px',
    textAlign: 'right' as const,
  },
  applyButton: {
    width: '100%',
    padding: '10px',
    fontSize: '13px',
    fontWeight: 600,
    border: 'none',
    borderRadius: '6px',
    cursor: 'pointer',
    backgroundColor: '#3b82f6',
    color: '#fff',
    marginTop: '8px',
    transition: 'all 0.2s',
  },

  // Canvas Area
  canvasArea: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    padding: '16px',
    gap: '12px',
    overflow: 'hidden',
  },
  canvasWrapper: {
    flex: 1,
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#0a0a14',
    borderRadius: '8px',
    overflow: 'hidden',
  },
  canvas: {
    borderRadius: '4px',
    cursor: 'grab',
  },

  // Control Bar
  controlBar: {
    display: 'flex',
    alignItems: 'center',
    gap: '24px',
    padding: '12px 16px',
    backgroundColor: '#1a1a2e',
    borderRadius: '8px',
  },
  controlSection: {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
  },
  controlLabel: {
    fontSize: '12px',
    color: '#888',
    fontWeight: 500,
    minWidth: '55px',
  },
  controlValue: {
    fontSize: '12px',
    color: '#e0e0e0',
    fontWeight: 600,
    minWidth: '40px',
    textAlign: 'right' as const,
  },
  slider: {
    width: '100px',
    cursor: 'pointer',
  },
  buttonGroup: {
    display: 'flex',
    gap: '8px',
    marginLeft: 'auto',
  },

  // Buttons
  buttonPrimary: {
    padding: '8px 16px',
    fontSize: '13px',
    fontWeight: 600,
    border: 'none',
    borderRadius: '6px',
    cursor: 'pointer',
    backgroundColor: '#22c55e',
    color: '#fff',
    transition: 'all 0.2s',
  },
  buttonWarning: {
    padding: '8px 16px',
    fontSize: '13px',
    fontWeight: 600,
    border: 'none',
    borderRadius: '6px',
    cursor: 'pointer',
    backgroundColor: '#f97316',
    color: '#fff',
    transition: 'all 0.2s',
  },
  buttonSecondary: {
    padding: '8px 16px',
    fontSize: '13px',
    fontWeight: 600,
    border: '1px solid #3d3d5c',
    borderRadius: '6px',
    cursor: 'pointer',
    backgroundColor: 'transparent',
    color: '#a0a0b0',
    transition: 'all 0.2s',
  },
  buttonDanger: {
    padding: '8px 16px',
    fontSize: '13px',
    fontWeight: 600,
    border: 'none',
    borderRadius: '6px',
    cursor: 'pointer',
    backgroundColor: '#ef4444',
    color: '#fff',
    transition: 'all 0.2s',
  },
  buttonInfo: {
    padding: '8px 16px',
    fontSize: '13px',
    fontWeight: 600,
    border: 'none',
    borderRadius: '6px',
    cursor: 'pointer',
    backgroundColor: '#3b82f6',
    color: '#fff',
    transition: 'all 0.2s',
  },

  // Status Bar
  statusBar: {
    display: 'flex',
    alignItems: 'center',
    gap: '16px',
    padding: '10px 16px',
    backgroundColor: '#1a1a2e',
    borderRadius: '8px',
    fontSize: '13px',
  },
  statusItem: {
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
  },
  statusLabel: {
    fontSize: '10px',
    color: '#666',
    textTransform: 'uppercase',
    letterSpacing: '0.5px',
  },
  statusValue: {
    fontSize: '14px',
    fontWeight: 600,
    color: '#e0e0e0',
  },
  statusDivider: {
    width: '1px',
    height: '30px',
    backgroundColor: '#2d2d44',
  },
  statusHint: {
    fontSize: '11px',
    color: '#555',
  },
};
