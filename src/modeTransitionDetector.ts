export type MarkdownMode = 'source' | 'preview' | 'hybrid';

export interface MarkdownTabSnapshot<Group> {
	readonly group: Group;
	readonly mode: MarkdownMode;
	readonly resource: string;
}

export type GroupSnapshot = ReadonlyMap<string, ReadonlyMap<MarkdownMode, number>>;

interface TimedMarkdownTab<Group> {
	readonly tab: MarkdownTabSnapshot<Group>;
	readonly timestamp: number;
}

const MARKDOWN_MODES: readonly MarkdownMode[] = ['source', 'preview', 'hybrid'];

export function detectInPlaceTransition<Group>(
	previous: MarkdownTabSnapshot<Group> | undefined,
	current: MarkdownTabSnapshot<Group> | undefined
): MarkdownMode | undefined {
	if (previous
		&& current
		&& isSameEditorSlot(previous, current)
		&& previous.mode !== current.mode) {
		return current.mode;
	}

	return undefined;
}

export class ReplacementEventDetector<Group> {
	private recentClosedTabs: TimedMarkdownTab<Group>[] = [];
	private recentOpenedTabs: TimedMarkdownTab<Group>[] = [];

	public constructor(private readonly replacementWindowMs: number) { }

	public observeClosed(tab: MarkdownTabSnapshot<Group>, timestamp: number): MarkdownMode | undefined {
		this.prune(timestamp);

		const matchingOpening = this.recentOpenedTabs.findIndex(candidate => isSameEditorSlot(candidate.tab, tab));
		if (matchingOpening >= 0) {
			const [opened] = this.recentOpenedTabs.splice(matchingOpening, 1);
			if (opened.tab.mode !== tab.mode) {
				return opened.tab.mode;
			}
		}

		// A same-mode open/close can immediately precede another open in a
		// different mode, so keep this closure available for that transition.
		this.recentClosedTabs.push({ tab, timestamp });
		return undefined;
	}

	public observeOpened(tab: MarkdownTabSnapshot<Group>, timestamp: number): MarkdownMode | undefined {
		this.prune(timestamp);

		const matchingClosure = this.recentClosedTabs.findIndex(candidate => isSameEditorSlot(candidate.tab, tab));
		if (matchingClosure >= 0) {
			const [closed] = this.recentClosedTabs.splice(matchingClosure, 1);
			if (closed.tab.mode !== tab.mode) {
				return tab.mode;
			}
		}

		// Keep a same-mode reopening available in case VS Code reports the close
		// half of an editor replacement after the open half.
		this.recentOpenedTabs.push({ tab, timestamp });
		return undefined;
	}

	private prune(timestamp: number): void {
		const isRecent = (candidate: TimedMarkdownTab<Group>): boolean =>
			timestamp - candidate.timestamp <= this.replacementWindowMs;
		this.recentClosedTabs = this.recentClosedTabs.filter(isRecent);
		this.recentOpenedTabs = this.recentOpenedTabs.filter(isRecent);
	}
}

export function createGroupSnapshot<Group>(tabs: Iterable<MarkdownTabSnapshot<Group>>): GroupSnapshot {
	const snapshot = new Map<string, Map<MarkdownMode, number>>();
	for (const tab of tabs) {
		const modes = snapshot.get(tab.resource) ?? new Map<MarkdownMode, number>();
		modes.set(tab.mode, (modes.get(tab.mode) ?? 0) + 1);
		snapshot.set(tab.resource, modes);
	}
	return snapshot;
}

export function detectGroupTransitions(previous: GroupSnapshot, current: GroupSnapshot): MarkdownMode[] {
	const transitions: MarkdownMode[] = [];
	for (const [resource, previousModes] of previous) {
		const currentModes = current.get(resource);
		if (!currentModes) {
			continue;
		}

		const removedModes = modeCountDifference(previousModes, currentModes);
		const addedModes = modeCountDifference(currentModes, previousModes);
		if (removedModes.length === 1 && addedModes.length === 1 && removedModes[0] !== addedModes[0]) {
			transitions.push(addedModes[0]);
		}
	}
	return transitions;
}

function isSameEditorSlot<Group>(left: MarkdownTabSnapshot<Group>, right: MarkdownTabSnapshot<Group>): boolean {
	return left.group === right.group && left.resource === right.resource;
}

function modeCountDifference(
	left: ReadonlyMap<MarkdownMode, number>,
	right: ReadonlyMap<MarkdownMode, number>
): MarkdownMode[] {
	const difference: MarkdownMode[] = [];
	for (const mode of MARKDOWN_MODES) {
		const count = (left.get(mode) ?? 0) - (right.get(mode) ?? 0);
		for (let index = 0; index < count; index += 1) {
			difference.push(mode);
		}
	}
	return difference;
}
