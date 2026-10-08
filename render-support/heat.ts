/** A theme that can also report each token's live foreground escape, as Pi's `Theme` does. */
export interface HeatTheme {
	fg(token: string, text: string): string;
	getFgAnsi?(token: string): string;
	getColorMode?(): string;
}

type Rgb = readonly [number, number, number];
type HeatStop = { at: number; token: string; quiet?: boolean };

/** Quiet at empty, loud at full. Mirrors the context ramp of the `custom-footer` extension. */
const CONTEXT_HEAT_STOPS: readonly HeatStop[] = [
	{ at: 0, token: "success", quiet: true },
	{ at: 40, token: "success" },
	{ at: 70, token: "warning" },
	{ at: 100, token: "error" },
];
const QUIET_BLEND = 0.38;
const GAUGE_GLYPHS = "▁▂▃▄▅▆▇█";

/** @example contextGauge(16) // "▂" */
export function contextGauge(percent: number): string {
	return GAUGE_GLYPHS[Math.min(GAUGE_GLYPHS.length - 1, Math.floor(percent / (100 / GAUGE_GLYPHS.length)))]!;
}

function tokenRgb(theme: HeatTheme, token: string): Rgb | undefined {
	const match = theme.getFgAnsi?.(token).match(/\x1b\[38;2;(\d+);(\d+);(\d+)m/);
	return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}

/** @example blendRgb([0, 0, 0], [100, 200, 50], 0.5) // [50, 100, 25] */
function blendRgb(start: Rgb, end: Rgb, ratio: number): Rgb {
	return [0, 1, 2].map((channel) => Math.round(start[channel]! + (end[channel]! - start[channel]!) * ratio)) as unknown as Rgb;
}

function stopRgb(theme: HeatTheme, stop: HeatStop): Rgb | undefined {
	const base = tokenRgb(theme, stop.token);
	if (!stop.quiet) return base;
	const dim = tokenRgb(theme, "dim");
	return base && dim ? blendRgb(base, dim, QUIET_BLEND) : undefined;
}

/**
 * Colors `text` by where `percent` sits on the context ramp. Without truecolor theme values
 * (a 256-color terminal or palette-index tokens), it uses the nearest stop's token instead of a blend.
 */
export function contextHeat(theme: HeatTheme, percent: number, text: string): string {
	const value = Math.min(100, Math.max(0, percent));
	const upper = Math.max(1, CONTEXT_HEAT_STOPS.findIndex((stop) => stop.at >= value));
	const low = CONTEXT_HEAT_STOPS[upper - 1]!;
	const high = CONTEXT_HEAT_STOPS[upper]!;
	const lowRgb = stopRgb(theme, low);
	const highRgb = stopRgb(theme, high);
	if (theme.getColorMode?.() === "256color" || !lowRgb || !highRgb) {
		const nearest = value - low.at <= high.at - value ? low : high;
		return theme.fg(nearest.token, text);
	}
	const [red, green, blue] = blendRgb(lowRgb, highRgb, (value - low.at) / (high.at - low.at));
	return `\x1b[38;2;${red};${green};${blue}m${text}\x1b[39m`;
}
