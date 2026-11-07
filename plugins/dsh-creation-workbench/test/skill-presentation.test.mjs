import test from 'node:test';
import assert from 'node:assert/strict';
import { skillLabel, skillSearchText } from '../src/skill-presentation.mjs';

test('skill labels prefer the user alias and fall back to the raw name', () => {
  assert.equal(skillLabel({ name: 'any-skill', label: '我的技能' }), '我的技能');
  assert.equal(skillLabel({ name: 'any-skill' }), 'any-skill');
  assert.equal(skillLabel({ name: 'any-skill', label: '' }), 'any-skill');
  assert.equal(skillLabel({ name: 'any-skill', label: '  ' }), 'any-skill');
});

test('skill search text keeps label, name and description searchable', () => {
  assert.equal(skillSearchText({ name: 'My-Skill', label: '我的技能', description: '说明' }), '我的技能 my-skill 说明');
  assert.equal(skillSearchText({ name: 'My-Skill' }), 'my-skill my-skill ');
});
