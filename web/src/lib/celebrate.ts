import confetti from 'canvas-confetti';

const BRAND = ['#ff3d7f', '#ffd23f', '#3fd8ff', '#4ade9b', '#9d86ff'];

/** Confetti for a correct answer. `strength` 0..1 scales the burst; `color` tints it (e.g. a team colour). */
export function celebrate(strength = 0.7, color?: string) {
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
  const colors = color ? [color, color, '#ffffff', '#ffd23f'] : BRAND;
  const count = Math.round(50 + strength * 150);
  confetti({ particleCount: count, spread: 75, startVelocity: 45, origin: { y: 0.65 }, colors, zIndex: 100 });
  if (strength > 0.6) {
    // side cannons for the great guesses
    setTimeout(() => {
      confetti({ particleCount: Math.round(count / 2), angle: 60, spread: 55, origin: { x: 0, y: 0.75 }, colors, zIndex: 100 });
      confetti({ particleCount: Math.round(count / 2), angle: 120, spread: 55, origin: { x: 1, y: 0.75 }, colors, zIndex: 100 });
    }, 180);
  }
}
