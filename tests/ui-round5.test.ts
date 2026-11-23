// Round-5 UI wording: what the panels say about sitting animals, fences, the guests' view,
// staff work and saving, and the fence stats the build menu shows.
import { describe, expect, it } from 'vitest';
import type { ISimulation } from '../src/core/contracts';
import { FENCES } from '../src/data/fences';
import { SPECIES_BY_ID } from '../src/data/species';
import { buildCatalog, fenceStatsText } from '../src/ui/catalog';
import { animalActionLabel, guestViewText, staffWorkText, weakestFenceText } from '../src/ui/panels';
import { saveToast } from '../src/ui/zoopanel';

describe('animal action labels', () => {
  it("names 'sit' after the pose the species' rig draws", () => {
    const sit = (id: string) => animalActionLabel('sit', SPECIES_BY_ID[id]);
    expect(sit('lion')).toBe('Sitting'); // cat sit
    expect(sit('gorilla')).toBe('Sitting'); // primate rig
    expect(sit('penguin')).toBe('Sitting');
    expect(sit('flamingo')).toBe('Sitting');
    expect(sit('tiger')).toBe('Resting'); // sits up or lies down
    expect(sit('grizzly')).toBe('Resting');
    expect(sit('zebra')).toBe('Lying down'); // sit is the rest pose
    expect(sit('elephant')).toBe('Lying down');
    expect(animalActionLabel('eat', SPECIES_BY_ID.lion)).toBe('Eating');
    expect(animalActionLabel('sit', undefined)).toBe('Lying down');
  });
});

describe('habitat panel', () => {
  it('names every fence type at the weakest strength', () => {
    expect(weakestFenceText({ minFenceStrength: 3, weakestFenceIds: [3, 4] })).toBe('3/4 · Stone / Glass');
    expect(weakestFenceText({ minFenceStrength: 3, weakestFenceIds: [4] })).toBe('3/4 · Glass');
    expect(weakestFenceText({ minFenceStrength: 4, weakestFenceIds: [5] })).toBe('4/4 · Steel');
    expect(weakestFenceText({ minFenceStrength: 4, weakestFenceIds: [] })).toBe('4/4');
  });

  it("rates the guests' view by how much the fences facing the paths let them see", () => {
    expect(guestViewText(false, 1)).toEqual({ text: 'No path nearby', kind: 'warn' });
    expect(guestViewText(true, 0.25)).toEqual({ text: 'Poor — walls block the view', kind: 'warn' }); // all stone
    expect(guestViewText(true, 0.47)).toEqual({ text: 'Poor — walls block the view', kind: 'warn' }); // Lion Kopje
    expect(guestViewText(true, 0.6)).toEqual({ text: 'Partial', kind: 'good' }); // steel bars
    expect(guestViewText(true, 1)).toEqual({ text: 'Good', kind: 'good' }); // glass
  });
});

describe('staff panel', () => {
  it("says what each role did today in that role's terms", () => {
    const w = { cleaned: 7, serviced: 1, treated: 2, recaptured: 0 };
    expect(staffWorkText('keeper', w)).toBe('1 habitat fed · 7 dung piles cleared');
    expect(staffWorkText('groundskeeper', { ...w, cleaned: 1 })).toBe('1 piece of litter picked up');
    expect(staffWorkText('vet', w)).toBe('2 animals treated · 0 brought back');
  });
});

describe('Save now', () => {
  it('only claims a save that happened', () => {
    expect(saveToast('saved')).toEqual({ text: 'Zoo saved', kind: 'good' });
    expect(saveToast('showcase')).toEqual({ text: 'Showcase zoos are not saved', kind: 'info' });
    expect(saveToast('kept')?.kind).toBe('info');
    expect(saveToast('failed')).toBeNull(); // main.ts reports the failure itself
    expect(saveToast(undefined)).toEqual({ text: 'Zoo saved', kind: 'good' }); // a host without a status
  });
});

describe('build menu fences', () => {
  it('carry strength and view for the cards and the tool bar', () => {
    const habitats = buildCatalog({} as ISimulation).find((c) => c.id === 'habitats')!;
    const fences = habitats.items.filter((i) => i.tool.kind === 'fence');
    expect(fences.map((f) => f.fence)).toEqual(FENCES.map((f) => ({ strength: f.strength, visibility: f.visibility })));
    expect(habitats.items.filter((i) => i.fence).length).toBe(FENCES.length);
    const stone = FENCES.find((f) => f.key === 'stone')!;
    expect(fenceStatsText(stone)).toBe('Strength 3/4 · 25% view');
  });
});
