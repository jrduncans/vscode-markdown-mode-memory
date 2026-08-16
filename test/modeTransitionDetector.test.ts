import assert from 'node:assert/strict';
import test from 'node:test';
import {
	createGroupSnapshot,
	detectGroupTransitions,
	detectInPlaceTransition,
	MarkdownMode,
	MarkdownTabSnapshot,
	ReplacementEventDetector
} from '../src/modeTransitionDetector';

interface TestGroup {
	readonly name: string;
}

const groupA: TestGroup = { name: 'A' };
const groupB: TestGroup = { name: 'B' };
const notes = 'file:///workspace/notes.md';
const readme = 'file:///workspace/README.md';

function tab(
	mode: MarkdownMode,
	resource = notes,
	group: TestGroup = groupA
): MarkdownTabSnapshot<TestGroup> {
	return { group, mode, resource };
}

test('detects an in-place mode change for the same tab slot', () => {
	assert.equal(detectInPlaceTransition(tab('source'), tab('preview')), 'preview');
});

test('ignores in-place updates without a mode change', () => {
	assert.equal(detectInPlaceTransition(tab('source'), tab('source')), undefined);
	assert.equal(detectInPlaceTransition(tab('source'), tab('preview', readme)), undefined);
	assert.equal(detectInPlaceTransition(tab('source'), tab('preview', notes, groupB)), undefined);
	assert.equal(detectInPlaceTransition(undefined, tab('preview')), undefined);
});

test('detects a close-then-open editor replacement', () => {
	const detector = new ReplacementEventDetector<TestGroup>(2_000);

	assert.equal(detector.observeClosed(tab('source'), 100), undefined);
	assert.equal(detector.observeOpened(tab('preview'), 101), 'preview');
});

test('detects an open-then-close editor replacement', () => {
	const detector = new ReplacementEventDetector<TestGroup>(2_000);

	assert.equal(detector.observeOpened(tab('hybrid'), 100), undefined);
	assert.equal(detector.observeClosed(tab('preview'), 101), 'hybrid');
});

test('keeps a same-mode open and close available for a following replacement', () => {
	const detector = new ReplacementEventDetector<TestGroup>(2_000);

	assert.equal(detector.observeOpened(tab('source'), 100), undefined);
	assert.equal(detector.observeClosed(tab('source'), 101), undefined);
	assert.equal(detector.observeOpened(tab('preview'), 102), 'preview');
});

test('does not treat the same mode as a replacement', () => {
	const detector = new ReplacementEventDetector<TestGroup>(2_000);

	assert.equal(detector.observeClosed(tab('preview'), 100), undefined);
	assert.equal(detector.observeOpened(tab('preview'), 101), undefined);
});

test('does not pair events for different resources or groups', () => {
	const detector = new ReplacementEventDetector<TestGroup>(2_000);

	assert.equal(detector.observeClosed(tab('source'), 100), undefined);
	assert.equal(detector.observeOpened(tab('preview', readme), 101), undefined);
	assert.equal(detector.observeOpened(tab('hybrid', notes, groupB), 102), undefined);
});

test('does not pair replacement events outside the timing window', () => {
	const detector = new ReplacementEventDetector<TestGroup>(2_000);

	assert.equal(detector.observeClosed(tab('source'), 100), undefined);
	assert.equal(detector.observeOpened(tab('preview'), 2_101), undefined);
});

test('detects a replacement during a full tab-group rebuild', () => {
	const previous = createGroupSnapshot([tab('source')]);
	const current = createGroupSnapshot([tab('hybrid')]);

	assert.deepEqual(detectGroupTransitions(previous, current), ['hybrid']);
});

test('detects replacement of one of several duplicate-resource tabs', () => {
	const previous = createGroupSnapshot([tab('source'), tab('source')]);
	const current = createGroupSnapshot([tab('source'), tab('preview')]);

	assert.deepEqual(detectGroupTransitions(previous, current), ['preview']);
});

test('detects independent replacements for multiple resources', () => {
	const previous = createGroupSnapshot([
		tab('source', notes),
		tab('preview', readme)
	]);
	const current = createGroupSnapshot([
		tab('preview', notes),
		tab('hybrid', readme)
	]);

	assert.deepEqual(detectGroupTransitions(previous, current), ['preview', 'hybrid']);
});

test('ignores ordinary opens, closes, and unchanged group rebuilds', () => {
	const sourceOnly = createGroupSnapshot([tab('source', notes)]);
	const sourceAndReadme = createGroupSnapshot([
		tab('source', notes),
		tab('source', readme)
	]);

	assert.deepEqual(detectGroupTransitions(sourceOnly, sourceAndReadme), []);
	assert.deepEqual(detectGroupTransitions(sourceAndReadme, sourceOnly), []);
	assert.deepEqual(detectGroupTransitions(sourceOnly, sourceOnly), []);
});

test('ignores an ambiguous full-group change', () => {
	const previous = createGroupSnapshot([tab('source')]);
	const current = createGroupSnapshot([tab('preview'), tab('hybrid')]);

	assert.deepEqual(detectGroupTransitions(previous, current), []);
});
