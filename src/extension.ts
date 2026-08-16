import * as vscode from 'vscode';

type MarkdownMode = 'source' | 'preview' | 'hybrid';
type ManagementState = 'managing' | 'notManaging';

interface MarkdownTab {
	readonly group: vscode.TabGroup;
	readonly mode: MarkdownMode;
	readonly uri: vscode.Uri;
}

interface TimedMarkdownTab {
	readonly tab: MarkdownTab;
	readonly timestamp: number;
}

interface OriginalAssociation {
	readonly value: string | undefined;
}

type EditorAssociations = Record<string, string>;
type GroupSnapshot = Map<string, Map<MarkdownMode, number>>;

const MANAGEMENT_STATE_KEY = 'managementState';
const ORIGINAL_ASSOCIATION_KEY = 'originalMarkdownAssociation';
const MARKDOWN_GLOB = '*.md';

const MARKDOWN_PREVIEW_EDITOR = 'vscode.markdown.preview.editor';
const MARKDOWN_HYBRID_EDITOR = 'vscode.markdown.editor';
const REPLACEMENT_WINDOW_MS = 2_000;

export function activate(context: vscode.ExtensionContext): void {
	const controller = new MarkdownAssociationController(context);
	context.subscriptions.push(controller);
	context.subscriptions.push(
		vscode.commands.registerCommand(
			'markdownModeMemory.startManagingWorkspace',
			() => controller.startManagingWorkspace()
		),
		vscode.commands.registerCommand(
			'markdownModeMemory.stopManagingAndRestorePreference',
			() => controller.stopManagingAndRestorePreference()
		)
	);
	controller.start();
}

class MarkdownAssociationController implements vscode.Disposable {
	private readonly tabSnapshots = new WeakMap<vscode.Tab, MarkdownTab>();
	private readonly groupSnapshots = new WeakMap<vscode.TabGroup, GroupSnapshot>();
	private recentClosedTabs: TimedMarkdownTab[] = [];
	private recentOpenedTabs: TimedMarkdownTab[] = [];
	private updateQueue: Promise<void> = Promise.resolve();
	private hasShownNoWorkspaceWarning = false;
	private readonly disposables: vscode.Disposable[] = [];
	private readonly output = vscode.window.createOutputChannel('Markdown Mode Memory');

	public constructor(private readonly context: vscode.ExtensionContext) {
		this.disposables.push(this.output);
	}

	public start(): void {
		this.disposables.push(
			vscode.window.tabGroups.onDidChangeTabs(event => this.observeTabChanges(event)),
			vscode.window.tabGroups.onDidChangeTabGroups(event => this.observeTabGroupChanges(event))
		);

		this.snapshotOpenTabs();
	}

	public async startManagingWorkspace(): Promise<void> {
		await this.updateQueue;

		if (!this.hasWorkspace()) {
			void vscode.window.showWarningMessage('Markdown Mode Memory needs an open folder or workspace to manage its Markdown editor preference.');
			return;
		}

		if (this.managementState() === 'managing') {
			void vscode.window.showInformationMessage('Markdown Mode Memory is already managing this workspace\'s Markdown editor preference.');
			return;
		}

		await this.beginManaging();
		void vscode.window.showInformationMessage('Markdown Mode Memory will remember the next Markdown view you select in this workspace.');
	}

	public async stopManagingAndRestorePreference(): Promise<void> {
		await this.updateQueue;

		if (this.managementState() !== 'managing') {
			void vscode.window.showInformationMessage('Markdown Mode Memory is not managing this workspace\'s Markdown editor preference.');
			return;
		}

		if (!this.hasWorkspace()) {
			void vscode.window.showWarningMessage('Markdown Mode Memory needs an open folder or workspace to restore its Markdown editor preference.');
			return;
		}

		const original = this.context.workspaceState.get<OriginalAssociation>(ORIGINAL_ASSOCIATION_KEY) ?? { value: undefined };
		const associations = this.workspaceAssociations();
		delete associations[MARKDOWN_GLOB];
		if (original.value !== undefined) {
			associations[MARKDOWN_GLOB] = original.value;
		}

		await this.updateWorkspaceAssociations(associations);
		await this.context.workspaceState.update(MANAGEMENT_STATE_KEY, 'notManaging' satisfies ManagementState);
		await this.context.workspaceState.update(ORIGINAL_ASSOCIATION_KEY, undefined);
		void vscode.window.showInformationMessage('Markdown Mode Memory stopped managing this workspace and restored its previous Markdown editor preference.');
	}

	public dispose(): void {
		for (const disposable of this.disposables) {
			disposable.dispose();
		}
	}

	private observeTabChanges(event: vscode.TabChangeEvent): void {
		const now = Date.now();
		this.pruneRecentTabs(now);

		// VS Code reports editor replacement as separate close and open events. Read
		// closed tabs from snapshots taken while the tab was still valid.
		for (const closedTab of event.closed) {
			const closedMarkdownTab = this.tabSnapshots.get(closedTab);
			this.tabSnapshots.delete(closedTab);
			if (closedMarkdownTab) {
				this.observeClosedTab(closedMarkdownTab, now);
			}
		}

		// A tab object has stable identity across update events, so its snapshot
		// gives us the previous editor mode if VS Code updates it in place.
		for (const changedTab of event.changed) {
			const previous = this.tabSnapshots.get(changedTab);
			const current = this.getMarkdownTab(changedTab);
			if (previous && current && this.isSameEditorSlot(previous, current) && previous.mode !== current.mode) {
				this.queueWorkspacePreferenceUpdate(current.mode);
			}
			this.saveSnapshot(changedTab, current);
		}

		for (const openedTab of event.opened) {
			const openedMarkdownTab = this.getMarkdownTab(openedTab);
			if (openedMarkdownTab) {
				this.observeOpenedTab(openedMarkdownTab, now);
			}
			this.saveSnapshot(openedTab, openedMarkdownTab);
		}

		this.snapshotOpenTabs();
	}

	private observeTabGroupChanges(event: vscode.TabGroupChangeEvent): void {
		// Some editor replacements cause VS Code to rebuild its tab model instead
		// of emitting granular close/open events. Compare the previous and current
		// contents of changed groups so those replacements are not lost.
		for (const group of event.changed) {
			const previous = this.groupSnapshots.get(group);
			const current = this.createGroupSnapshot(group);
			if (previous) {
				this.observeGroupReplacement(previous, current);
			}
		}

		for (const group of event.closed) {
			this.groupSnapshots.delete(group);
		}

		this.snapshotOpenTabs();
	}

	private observeGroupReplacement(previous: GroupSnapshot, current: GroupSnapshot): void {
		for (const [uri, previousModes] of previous) {
			const currentModes = current.get(uri);
			if (!currentModes) {
				continue;
			}

			const removedModes = this.modeCountDifference(previousModes, currentModes);
			const addedModes = this.modeCountDifference(currentModes, previousModes);
			if (removedModes.length === 1 && addedModes.length === 1 && removedModes[0] !== addedModes[0]) {
				this.queueWorkspacePreferenceUpdate(addedModes[0]);
			}
		}
	}

	private modeCountDifference(
		left: ReadonlyMap<MarkdownMode, number>,
		right: ReadonlyMap<MarkdownMode, number>
	): MarkdownMode[] {
		const difference: MarkdownMode[] = [];
		for (const mode of ['source', 'preview', 'hybrid'] as const) {
			const count = (left.get(mode) ?? 0) - (right.get(mode) ?? 0);
			for (let index = 0; index < count; index += 1) {
				difference.push(mode);
			}
		}
		return difference;
	}

	private observeClosedTab(closedTab: MarkdownTab, now: number): void {
		const matchingOpening = this.recentOpenedTabs.findIndex(candidate => this.isSameEditorSlot(candidate.tab, closedTab));
		if (matchingOpening >= 0) {
			const [opened] = this.recentOpenedTabs.splice(matchingOpening, 1);
			if (opened.tab.mode !== closedTab.mode) {
				this.queueWorkspacePreferenceUpdate(opened.tab.mode);
				return;
			}
		}

		// A same-mode open/close can immediately precede another open in a
		// different mode, so keep this closure available for that transition.
		this.recentClosedTabs.push({ tab: closedTab, timestamp: now });
	}

	private observeOpenedTab(openedTab: MarkdownTab, now: number): void {
		const matchingClosure = this.recentClosedTabs.findIndex(candidate => this.isSameEditorSlot(candidate.tab, openedTab));
		if (matchingClosure >= 0) {
			const [closed] = this.recentClosedTabs.splice(matchingClosure, 1);
			if (closed.tab.mode !== openedTab.mode) {
				this.queueWorkspacePreferenceUpdate(openedTab.mode);
				return;
			}
		}

		// Keep a same-mode reopening available in case VS Code reports the close
		// half of an editor replacement after the open half.
		this.recentOpenedTabs.push({ tab: openedTab, timestamp: now });
	}

	private isSameEditorSlot(left: MarkdownTab, right: MarkdownTab): boolean {
		return left.group === right.group && left.uri.toString() === right.uri.toString();
	}

	private pruneRecentTabs(now: number): void {
		const isRecent = (candidate: TimedMarkdownTab) => now - candidate.timestamp <= REPLACEMENT_WINDOW_MS;
		this.recentClosedTabs = this.recentClosedTabs.filter(isRecent);
		this.recentOpenedTabs = this.recentOpenedTabs.filter(isRecent);
	}

	private snapshotOpenTabs(): void {
		for (const group of vscode.window.tabGroups.all) {
			this.groupSnapshots.set(group, this.createGroupSnapshot(group));
			for (const tab of group.tabs) {
				this.saveSnapshot(tab, this.getMarkdownTab(tab));
			}
		}
	}

	private createGroupSnapshot(group: vscode.TabGroup): GroupSnapshot {
		const snapshot: GroupSnapshot = new Map();
		for (const tab of group.tabs) {
			const markdownTab = this.getMarkdownTab(tab);
			if (!markdownTab) {
				continue;
			}

			const uri = markdownTab.uri.toString();
			const modes = snapshot.get(uri) ?? new Map<MarkdownMode, number>();
			modes.set(markdownTab.mode, (modes.get(markdownTab.mode) ?? 0) + 1);
			snapshot.set(uri, modes);
		}
		return snapshot;
	}

	private saveSnapshot(tab: vscode.Tab, markdownTab: MarkdownTab | undefined): void {
		if (markdownTab) {
			this.tabSnapshots.set(tab, markdownTab);
		} else {
			this.tabSnapshots.delete(tab);
		}
	}

	private queueWorkspacePreferenceUpdate(mode: MarkdownMode): void {
		this.updateQueue = this.updateQueue
			.then(() => this.updateWorkspacePreference(mode))
			.catch(error => {
				const details = error instanceof Error ? error.stack ?? error.message : String(error);
				this.output.appendLine(`Could not update the workspace editor association.\n${details}`);
				void vscode.window.showErrorMessage('Markdown Mode Memory could not update the workspace Markdown editor preference. See the Markdown Mode Memory output channel for details.');
			});
	}

	private async updateWorkspacePreference(mode: MarkdownMode): Promise<void> {
		if (!this.hasWorkspace()) {
			if (!this.hasShownNoWorkspaceWarning) {
				this.hasShownNoWorkspaceWarning = true;
				void vscode.window.showWarningMessage('Markdown Mode Memory needs an open folder or workspace to remember a Markdown editor preference.');
			}
			return;
		}

		if (!await this.ensureManagementConsent()) {
			return;
		}

		await this.writeWorkspacePreference(mode);
	}

	private async writeWorkspacePreference(mode: MarkdownMode): Promise<void> {
		const associations = this.workspaceAssociations();
		const editorId = this.editorIdFor(mode);
		if (associations[MARKDOWN_GLOB] === editorId) {
			return;
		}

		associations[MARKDOWN_GLOB] = editorId;
		await this.updateWorkspaceAssociations(associations);
	}

	private async ensureManagementConsent(): Promise<boolean> {
		const state = this.managementState();
		if (state === 'managing') {
			return true;
		}
		if (state === 'notManaging') {
			return false;
		}

		const choice = await vscode.window.showInformationMessage(
			'Remember the last Markdown view used in this workspace?',
			{
				modal: true,
				detail: 'Markdown Mode Memory does this by updating this workspace\'s workbench.editorAssociations setting whenever you switch between source, preview, or hybrid view. This may modify .vscode/settings.json or the workspace file and can affect other people who use it.'
			},
			'Remember for This Workspace',
			'Not for This Workspace'
		);
		if (choice !== 'Remember for This Workspace') {
			await this.context.workspaceState.update(MANAGEMENT_STATE_KEY, 'notManaging' satisfies ManagementState);
			return false;
		}

		await this.beginManaging();
		return true;
	}

	private async beginManaging(): Promise<void> {
		const associations = this.workspaceAssociations();
		await this.context.workspaceState.update(ORIGINAL_ASSOCIATION_KEY, {
			value: associations[MARKDOWN_GLOB]
		} satisfies OriginalAssociation);
		await this.context.workspaceState.update(MANAGEMENT_STATE_KEY, 'managing' satisfies ManagementState);
	}

	private managementState(): ManagementState | undefined {
		return this.context.workspaceState.get<ManagementState>(MANAGEMENT_STATE_KEY);
	}

	private hasWorkspace(): boolean {
		return vscode.workspace.workspaceFile !== undefined
			|| (vscode.workspace.workspaceFolders !== undefined && vscode.workspace.workspaceFolders.length > 0);
	}

	private workspaceAssociations(): EditorAssociations {
		const configuration = vscode.workspace.getConfiguration('workbench');
		const inspection = configuration.inspect<EditorAssociations>('editorAssociations');
		return { ...(inspection?.workspaceValue ?? {}) };
	}

	private async updateWorkspaceAssociations(associations: EditorAssociations): Promise<void> {
		const value = Object.keys(associations).length > 0 ? associations : undefined;
		await vscode.workspace.getConfiguration('workbench').update(
			'editorAssociations',
			value,
			vscode.ConfigurationTarget.Workspace
		);
	}

	private editorIdFor(mode: MarkdownMode): string {
		switch (mode) {
			case 'source':
				return 'default';
			case 'preview':
				return MARKDOWN_PREVIEW_EDITOR;
			case 'hybrid':
				return MARKDOWN_HYBRID_EDITOR;
		}
	}

	private getMarkdownTab(tab: vscode.Tab | undefined): MarkdownTab | undefined {
		if (!tab) {
			return undefined;
		}

		const input = tab.input;
		if (input instanceof vscode.TabInputText) {
			return this.isMarkdownResource(input.uri) ? { group: tab.group, mode: 'source', uri: input.uri } : undefined;
		}

		if (input instanceof vscode.TabInputCustom
			&& (input.viewType === MARKDOWN_PREVIEW_EDITOR || input.viewType === MARKDOWN_HYBRID_EDITOR)
			&& this.isMarkdownResource(input.uri)) {
			return {
				group: tab.group,
				mode: input.viewType === MARKDOWN_PREVIEW_EDITOR ? 'preview' : 'hybrid',
				uri: input.uri
			};
		}

		return undefined;
	}

	private isMarkdownResource(uri: vscode.Uri): boolean {
		return uri.path.toLowerCase().endsWith('.md');
	}
}

export function deactivate(): void {
	// All resources are registered with the extension context.
}
