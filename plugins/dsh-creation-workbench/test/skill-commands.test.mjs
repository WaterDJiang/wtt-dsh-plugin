import test from 'node:test';
import assert from 'node:assert/strict';
import { extractSkillNames, skillQueryAtCursor } from '../src/skill-commands.mjs';

test('explicit Skill names follow Host token boundaries, preserve order and ignore file paths or URLs', () => {
  assert.deepEqual(extractSkillNames('/course-one 请使用 /other-2\n/course-one\t/a'), ['course-one', 'other-2', 'a']);
  assert.deepEqual(extractSkillNames('https://example.com/foo /home/demo/SKILL.md /usr/bin 5/8 a/foo //foo /foo/bar /foo, /foo- /Foo /foo_bar'), []);
  assert.deepEqual(extractSkillNames('中文/skill\n/skill-name 后续'), ['skill-name']);
  assert.deepEqual(extractSkillNames(undefined), []);
});

test('slash query exposes the full replacement range and rejects URL or path fragments', () => {
  assert.deepEqual(skillQueryAtCursor('先写 /cour 后续', 8), { query: 'cour', start: 3, end: 8 });
  assert.deepEqual(skillQueryAtCursor('/course-name', 4), { query: 'cou', start: 0, end: 12 });
  assert.deepEqual(skillQueryAtCursor('/', 1), { query: '', start: 0, end: 1 });
  assert.deepEqual(skillQueryAtCursor(' /course-', 9), { query: 'course-', start: 1, end: 9 });
  for (const value of ['https://site/', '/home/path', '/foo/bar', '//foo', 'text/foo', '/foo.md']) {
    assert.equal(skillQueryAtCursor(value, value.length), null, value);
  }
  assert.equal(skillQueryAtCursor('/foo/bar', 4), null);
  assert.equal(skillQueryAtCursor('/foo', 8), null);
});
