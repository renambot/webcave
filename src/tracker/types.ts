/**
 * Tracking bridge: what every tracker source produces, and what the bridge
 * turns it into.
 *
 *   tracker system --(its protocol)--> TrackerSource --(TrackerEvent)--> bridge
 *   bridge --(calibration, mapping)--> Manager: setHead, setWand, input
 *
 * A source knows one protocol (DTrack, NatNet, VRPN) and nothing about heads
 * or wands: it reports rigid-body poses by id or name in the tracker's own
 * units and axes, plus button and analog states for devices that have them.
 * The bridge maps those onto the CAVE's head and wand with the calibration
 * from the tracker config file. Keeping the two apart is what lets one
 * calibration file serve any tracker, and one source serve any installation.
 */

/** A rigid body pose as the tracker reports it: its units, its axes, its quaternion convention (x, y, z, w). */
export interface PoseEvent {
  kind: "pose";
  /** Numeric body id (DTrack, NatNet) or "device/sensor" for VRPN; names are resolved by the source when it knows them. */
  id: string;
  /** Optional display name, when the protocol carries one (NatNet model definitions). */
  name?: string;
  position: [number, number, number];
  /** Unit quaternion x, y, z, w in the tracker's frame. */
  rotation: [number, number, number, number];
  /** Tracker's own timestamp in seconds when it has one, else the arrival time. */
  time: number;
  /** False when the tracker reports the body as not currently tracked (occluded); the pose is then stale. */
  tracked: boolean;
}

/** Button states of a device (a Flystick, a VRPN Button server): index -> pressed. */
export interface ButtonsEvent {
  kind: "buttons";
  id: string;
  states: boolean[];
}

/** Analog channels of a device (a Flystick joystick, a VRPN Analog server): values in [-1, 1]. */
export interface AnalogEvent {
  kind: "analog";
  id: string;
  values: number[];
}

export type TrackerEvent = PoseEvent | ButtonsEvent | AnalogEvent;

export interface TrackerSource {
  readonly name: string;
  /** Start listening; events arrive through the callback, status lines through `log`. */
  start(onEvent: (e: TrackerEvent) => void, log: (msg: string) => void): Promise<void>;
  stop(): void;
}
