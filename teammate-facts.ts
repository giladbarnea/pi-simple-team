import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import { padVisible } from "./render-support/ansi.ts";
import { glyphs, glyphStyle } from "./render-support/glyphs.ts";
import { contextGauge, contextHeat, type HeatTheme } from "./render-support/heat.ts";

export interface FactTheme extends HeatTheme {
	bold(text: string): string;
}

/** The facts a teammate row can show. A missing field means the view does not show that fact. */
export interface TeammateView {
	name: string;
	live?: boolean;
	model?: string;
	thinking?: string;
	forkContext?: boolean;
	canManageOwnTeams?: boolean;
	showOnHerdrPane?: boolean;
	contextPercent?: number;
}

/** A teammate row: its view facts plus the status word, when the view shows one. */
export interface FactRow extends TeammateView {
	status?: string;
}

export type FactKey = "name" | "live" | "status" | "model" | "context" | "fork" | "manager" | "thinking" | "herdr";
type Form = "full" | "short" | "bare" | "icon";
type FormOrHidden = Form | "hidden";

interface Paint {
	theme: FactTheme;
	roster: string[];
	nameWidth: number;
}

/** Each form renders one cell. A cell is empty when the row lacks the fact. */
type Ladder = { full: (row: FactRow, paint: Paint) => string } & Partial<Record<Exclude<Form, "full">, (row: FactRow, paint: Paint) => string>>;

/** Left to right on every teammate row, across every view. */
export const FACT_ORDER: readonly FactKey[] = ["name", "live", "status", "model", "context", "fork", "manager", "thinking", "herdr"];

const TEAMMATE_HUE_TOKENS = ["mdCode", "customMessageLabel", "mdHeading"] as const;

/**
 * actorHueToken("main", ["scout"]) === "accent"; actorHueToken("scout", ["scout"]) === "mdCode"
 */
export function actorHueToken(name: string, roster: string[]): string {
	if (name === "main") return "accent";
	const index = roster.indexOf(name);
	return index === -1 ? "text" : TEAMMATE_HUE_TOKENS[index % TEAMMATE_HUE_TOKENS.length]!;
}

const STATUS_WORD_TOKENS: Record<string, string> = {
	active: "success",
	busy: "success",
	running: "success",
	working: "success",
	blocked: "warning",
	restarted: "warning",
	resumed: "success",
	waiting: "warning",
	available: "muted",
	dormant: "muted",
	idle: "muted",
	spawned: "muted",
	done: "dim",
	exited: "dim",
	stopped: "dim",
	error: "error",
	failed: "error",
};

/**
 * statusWordToken("working") === "success"; statusWordToken("reviewing") === "accent"
 */
export function statusWordToken(word: string): string {
	return STATUS_WORD_TOKENS[word.trim().toLowerCase()] ?? "accent";
}

export const DIM_SGR_OPEN = "\x1b[2m";
export const DIM_SGR_CLOSE = "\x1b[22m";

/** @example modelTail("openai-codex/gpt-6-astra") // "gpt-6-astra" */
function modelTail(model: string): string {
	return model.slice(model.lastIndexOf("/") + 1);
}

/** A boolean fact's ladder: every form is empty unless the row sets the flag. */
function flag(field: "forkContext" | "canManageOwnTeams" | "showOnHerdrPane", forms: Record<Form, string>): Ladder {
	const form = (text: string) => (row: FactRow, paint: Paint) => (row[field] ? paint.theme.fg("muted", text) : "");
	return { full: form(forms.full), short: form(forms.short), bare: form(forms.bare), icon: form(forms.icon) };
}

/** The context gauge and percent share one heat color; the label stays quiet. */
function context(label: string, withGauge = true): (row: FactRow, paint: Paint) => string {
	return (row, paint) => {
		if (row.contextPercent === undefined) return "";
		const reading = `${withGauge ? contextGauge(row.contextPercent) : ""}${Math.round(row.contextPercent)}%`;
		return `${contextHeat(paint.theme, row.contextPercent, reading)}${label ? paint.theme.fg("muted", ` ${label}`) : ""}`;
	};
}

const LADDERS: Record<FactKey, Ladder> = {
	name: {
		full: (row, paint) => {
			const name = paint.theme.fg(actorHueToken(row.name, paint.roster), padVisible(row.name, paint.nameWidth));
			return row.live === false ? `${DIM_SGR_OPEN}${name}${DIM_SGR_CLOSE}` : name;
		},
	},
	live: {
		full: (row, paint) => {
			if (row.live === undefined) return "";
			const g = glyphs();
			return row.live ? paint.theme.fg("muted", g.bullet.trim()) : paint.theme.fg("dim", g.emptyBullet.trim());
		},
	},
	status: { full: (row, paint) => (row.status ? paint.theme.fg(statusWordToken(row.status), row.status) : "") },
	model: {
		full: (row, paint) => (row.model ? paint.theme.fg("muted", row.model) : ""),
		short: (row, paint) => (row.model ? paint.theme.fg("muted", modelTail(row.model)) : ""),
	},
	context: { full: context("context"), short: context("ctx"), bare: context("ctx", false), icon: context("") },
	fork: flag("forkContext", { full: "⑂ fork", short: "⑂ fork", bare: "fork", icon: "⑂" }),
	manager: flag("canManageOwnTeams", { full: "〒 team manager", short: "〒 manager", bare: "manager", icon: "〒" }),
	thinking: { full: (row, paint) => (row.thinking ? paint.theme.fg("muted", row.thinking) : "") },
	herdr: flag("showOnHerdrPane", { full: "⧉ herdr pane", short: "⧉ herdr", bare: "herdr", icon: "⧉" }),
};

/**
 * The shrink state machine. State N applies the first N steps, so each later state is narrower.
 * First shorten labels, then drop icons from the labels, then keep icons alone, then hide whole facts.
 * Within each phase, the lowest-priority fact gives up width first.
 */
const SHRINK_STEPS: ReadonlyArray<readonly [FactKey, FormOrHidden]> = [
	["herdr", "short"], ["manager", "short"], ["context", "short"], ["model", "short"],
	["herdr", "bare"], ["manager", "bare"], ["fork", "bare"],
	["herdr", "icon"], ["manager", "icon"], ["fork", "icon"], ["context", "icon"],
	["herdr", "hidden"], ["thinking", "hidden"], ["manager", "hidden"], ["fork", "hidden"], ["context", "hidden"], ["model", "hidden"], ["status", "hidden"], ["live", "hidden"],
];

const FULL_FORMS = Object.fromEntries(FACT_ORDER.map((key) => [key, "full"])) as Record<FactKey, FormOrHidden>;

/** formsAt(1).herdr === "short" */
function formsAt(state: number): Record<FactKey, FormOrHidden> {
	return Object.fromEntries([...Object.entries(FULL_FORMS), ...SHRINK_STEPS.slice(0, state)]) as Record<FactKey, FormOrHidden>;
}

const COLUMN_GAP = "  ";

/** ASCII terminals have no fact icons, so any fact with a text-only form always uses it. */
function cell(key: FactKey, form: FormOrHidden, row: FactRow, paint: Paint): string {
	if (form === "hidden") return "";
	const ladder = LADDERS[key];
	const shown = glyphStyle() === "ascii" && ladder.bare ? "bare" : form;
	return ladder[shown]!(row, paint);
}

/** One fact in its icon form, for views that list teammates inline. Empty when the row lacks the fact. */
export function inlineFact(theme: FactTheme, key: FactKey, row: FactRow): string {
	return cell(key, "icon", row, { theme, roster: [], nameWidth: 0 });
}

/** The cells of every row at one state, padded into aligned columns. Empty columns drop out. */
function layoutRows(rows: FactRow[], paint: Paint, forms: Record<FactKey, FormOrHidden>): string[] {
	const columns = FACT_ORDER.map((key) => rows.map((row) => cell(key, forms[key], row, paint))).filter((cells) => cells.some((text) => text.length > 0));
	const widths = columns.map((cells) => Math.max(...cells.map((text) => visibleWidth(text))));
	return rows.map((_row, rowIndex) => columns.map((cells, columnIndex) => padVisible(cells[rowIndex]!, widths[columnIndex]!)).join(COLUMN_GAP).trimEnd());
}

/** One aligned set of teammate rows that shrinks as a whole to fit a width. */
export class FactTable {
	private readonly paint: Paint;
	private readonly fittedByWidth = new Map<number, string[]>();

	constructor(theme: FactTheme, private readonly rows: FactRow[], roster: string[]) {
		this.paint = { theme, roster, nameWidth: Math.max(...rows.map((row) => visibleWidth(row.name))) };
	}

	/** The row with every fact in its full form. */
	full(row: FactRow): string {
		return this.fitted(Number.POSITIVE_INFINITY)[this.rows.indexOf(row)]!;
	}

	/** The row at the widest state that fits `width`, clipped only when even the narrowest state does not. */
	fit(row: FactRow, width: number): string {
		return truncateToWidth(this.fitted(width)[this.rows.indexOf(row)]!, Math.max(1, width), glyphs().ellipsis);
	}

	private fitted(width: number): string[] {
		const cached = this.fittedByWidth.get(width);
		if (cached) return cached;
		let lines = layoutRows(this.rows, this.paint, formsAt(0));
		for (let state = 1; state <= SHRINK_STEPS.length && Math.max(...lines.map((line) => visibleWidth(line))) > width; state++) {
			lines = layoutRows(this.rows, this.paint, formsAt(state));
		}
		this.fittedByWidth.set(width, lines);
		return lines;
	}
}
