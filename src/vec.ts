/**
 * 2-D vectors and utilities.
 */
export interface Vec2 {
  x: number;
  y: number;
}

/**
 * Square of length of the vector
 */
export function vlen2(a: Vec2): number {
  return a.x * a.x + a.y * a.y;
}

/**
 * Length of the vector
 */
export function vlen(a: Vec2): number {
  return Math.sqrt(vlen2(a));
}

/**
 * Vector operation a - b
 */
export function vsub(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x - b.x, y: a.y - b.y };
}
/**
 * Scalar vector multiplication s * a
 */
export function vmul(a: Vec2, s: number): Vec2 {
  return { x: a.x * s, y: a.y * s };
}

/**
 * Get a normalized vector - length 1
 */
export function vnorm(a: Vec2): Vec2 {
  return vmul(a, 1 / vlen(a));
}

/**
 * Vector operation a + b
 */
export function vadd(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x + b.x, y: a.y + b.y };
}

/**
 * Vector dot-product a . b
 */
export function vdot(a: Vec2, b: Vec2): number {
  return a.x * b.x + a.y * b.y;
}

/**
 * Rotate vector "v" an angle "a" around a center point "c".
 */
export function vrot(v: Vec2, c: Vec2, a: number): Vec2 {
  if (a === 0) return v;

  const radians = (Math.PI / 180) * a;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const nx = cos * (v.x - c.x) - sin * (v.y - c.y) + c.x;
  const ny = cos * (v.y - c.y) + sin * (v.x - c.x) + c.y;

  return { x: nx, y: ny };
}
