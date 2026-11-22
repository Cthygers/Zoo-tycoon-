// Sun and moon positions for the game clock. Mid-latitude summer: sunrise
// ≈ 06:00, solar noon 13:00 (south, +Z), sunset ≈ 20:00. World axes: east =
// +X, north = −Z, up = +Y.

import * as THREE from 'three';

const LAT = (45 * Math.PI) / 180;
// declination chosen so the sun crosses the horizon 7 h from solar noon
const DECL = Math.atan(-Math.cos((105 * Math.PI) / 180) / Math.tan(LAT));
const SOLAR_NOON_H = 13;
const SYNODIC = 29.53;

function equatorialToWorld(hourAngle: number, decl: number, out: THREE.Vector3): THREE.Vector3 {
  const east = -Math.cos(decl) * Math.sin(hourAngle);
  const north = Math.sin(decl) * Math.cos(LAT) - Math.cos(decl) * Math.cos(hourAngle) * Math.sin(LAT);
  const up = Math.sin(decl) * Math.sin(LAT) + Math.cos(decl) * Math.cos(hourAngle) * Math.cos(LAT);
  return out.set(east, up, -north).normalize();
}

export interface Celestial {
  sunElev: number;
  moonElev: number;
  /** 0 = new … 1 = full. */
  moonIllum: number;
}

/** Writes sun / moon directions (pointing from the ground toward the body). */
export function computeCelestial(minuteOfDay: number, day: number, sunDir: THREE.Vector3, moonDir: THREE.Vector3): Celestial {
  const hours = minuteOfDay / 60;
  const H = ((hours - SOLAR_NOON_H) / 24) * Math.PI * 2;
  equatorialToWorld(H, DECL, sunDir);
  // Moon: roughly opposite the sun, drifting through a gibbous–full–gibbous
  // cycle so most nights have usable moonlight.
  const phase = (((day % SYNODIC) + SYNODIC) % SYNODIC) / SYNODIC;
  const offset = Math.sin(phase * Math.PI * 2) * 0.75 + 0.25;
  const moonDecl = -DECL * 0.6 + 0.09;
  equatorialToWorld(H + Math.PI + offset, moonDecl, moonDir);
  const elong = Math.acos(Math.min(1, Math.max(-1, sunDir.dot(moonDir))));
  return {
    sunElev: Math.asin(sunDir.y),
    moonElev: Math.asin(moonDir.y),
    moonIllum: (1 - Math.cos(elong)) / 2,
  };
}
