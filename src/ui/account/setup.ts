// Player setup (spec §3.3): a nickname with a live check (shared/names checkName, the server's
// own rules) and an avatar from 10 animals × 8 colours (src/ui/avatars). Used for the first
// player, "+ Add player" and Manage players' rename / change animal. Creating and changing
// players is online only; failures show the net layer's kid words under the field.
import type { Avatar, AvatarAnimal, ProfileDto } from '../../../shared/api-types';
import { AVATAR_ANIMALS, AVATAR_COLORS } from '../../../shared/limits';
import { checkName } from '../../../shared/names';
import type { CloudHandle } from '../../core/cloud-types';
import { AVATAR_COLOR_HEX, AVATAR_NAMES } from '../avatars';
import { button, el, toggleClass } from '../dom';
import { avatarEl, errorText, openPage } from './dialog';

export const NAME_HINT = 'Use a nickname. Friends you play Versus with will see it.';

/** Live feedback under the name field: nothing while empty, the filter's kid words, or "Nice name!". */
export function nameFeedback(raw: string): { ok: boolean; text: string } {
  if (!raw.trim()) return { ok: false, text: '' };
  const c = checkName(raw);
  return c.ok ? { ok: true, text: 'Nice name!' } : { ok: false, text: c.message };
}

/** A starting avatar no other player uses yet (animal first, then colour), from a seed. */
export function freshAvatar(taken: readonly Avatar[], seed = 0): Avatar {
  const n = AVATAR_ANIMALS.length * AVATAR_COLORS;
  for (let k = 0; k < n; k++) {
    const i = (seed + k * 7) % n;
    const a: Avatar = { animal: AVATAR_ANIMALS[i % AVATAR_ANIMALS.length] as AvatarAnimal, color: Math.floor(i / AVATAR_ANIMALS.length) % AVATAR_COLORS };
    if (!taken.some((t) => t.animal === a.animal)) return a;
  }
  for (let k = 0; k < n; k++) {
    const i = (seed + k * 7) % n;
    const a: Avatar = { animal: AVATAR_ANIMALS[i % AVATAR_ANIMALS.length] as AvatarAnimal, color: Math.floor(i / AVATAR_ANIMALS.length) % AVATAR_COLORS };
    if (!taken.some((t) => t.animal === a.animal && t.color === a.color)) return a;
  }
  return { animal: 'lion', color: 0 };
}

interface EditorOpts {
  title: string;
  okLabel: string;
  cancelLabel: string;
  note?: string;
  initial: { name: string; avatar: Avatar };
  focus?: 'name' | 'animal';
  /** Resolve when saved; reject with a FriendlyError to show its message. */
  save(name: string, avatar: Avatar): Promise<void>;
}

/** The editor page; resolves true once `save` succeeded, false on cancel / back. */
function playerEditor(container: HTMLElement, o: EditorOpts): Promise<boolean> {
  return new Promise((resolve) => {
    let avatar: Avatar = { ...o.initial.avatar };
    let busy = false;
    const finish = (v: boolean) => {
      page.close();
      resolve(v);
    };
    const page = openPage(container, { title: o.title, cls: 'wh-ac-setup-page', onBack: () => !busy && finish(false) });
    const preview = el('div', {});
    const input = el('input', {
      class: 'wh-ac-name',
      attrs: { type: 'text', maxlength: '40', autocomplete: 'off', autocapitalize: 'words', spellcheck: 'false', enterkeyhint: 'done', 'aria-label': 'Name', placeholder: 'Name' },
    }) as HTMLInputElement;
    input.value = o.initial.name;
    const msg = el('div', { class: 'wh-ac-namemsg', attrs: { 'aria-live': 'polite' } });
    const animals = el('div', { class: 'wh-ac-animals', attrs: { role: 'radiogroup', 'aria-label': 'Animal' } });
    const colors = el('div', { class: 'wh-ac-colors', attrs: { role: 'radiogroup', 'aria-label': 'Colour' } });
    const animalBtns = AVATAR_ANIMALS.map((an) => {
      const b = button('wh-ac-animal', null, null, () => {
        avatar = { ...avatar, animal: an as AvatarAnimal };
        draw();
      }, AVATAR_NAMES[an as AvatarAnimal]);
      b.setAttribute('role', 'radio');
      return b;
    });
    const colorBtns = Array.from({ length: AVATAR_COLORS }, (_, c) => {
      const b = button('wh-ac-color', null, null, () => {
        avatar = { ...avatar, color: c };
        draw();
      }, `Colour ${c + 1}`);
      b.style.background = AVATAR_COLOR_HEX[c];
      b.setAttribute('role', 'radio');
      return b;
    });
    animals.append(...animalBtns);
    colors.append(...colorBtns);
    const okBtn = button('wh-btn-primary', null, o.okLabel, () => void submit());
    const cancelBtn = button('wh-btn-ghost', null, o.cancelLabel, () => !busy && finish(false));
    const draw = () => {
      preview.replaceChildren(avatarEl(avatar, 84, 'wh-ac-preview'));
      animalBtns.forEach((b, i) => {
        const an = AVATAR_ANIMALS[i] as AvatarAnimal;
        b.replaceChildren(avatarEl({ animal: an, color: avatar.color }, 54));
        toggleClass(b, 'on', an === avatar.animal);
        b.setAttribute('aria-checked', String(an === avatar.animal));
      });
      colorBtns.forEach((b, i) => {
        toggleClass(b, 'on', i === avatar.color);
        b.setAttribute('aria-checked', String(i === avatar.color));
      });
    };
    const check = () => {
      const f = nameFeedback(input.value);
      msg.textContent = f.text;
      toggleClass(msg, 'ok', f.ok);
      toggleClass(input, 'bad', !f.ok && f.text !== '');
      okBtn.disabled = !f.ok || busy;
      return f.ok;
    };
    const submit = async () => {
      if (busy || !check()) return;
      busy = true;
      okBtn.disabled = cancelBtn.disabled = true;
      msg.textContent = 'Saving…';
      toggleClass(msg, 'ok', true);
      try {
        await o.save(input.value, avatar);
        busy = false;
        finish(true);
      } catch (e) {
        busy = false;
        cancelBtn.disabled = false;
        msg.textContent = errorText(e);
        toggleClass(msg, 'ok', false);
        okBtn.disabled = false;
      }
    };
    input.addEventListener('input', check);
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') {
        input.blur();
        void submit();
      }
    });
    page.body.append(
      el('div', 'wh-ac-setup', [
        el('div', 'wh-ac-setup-l', [preview, input, msg, el('div', { class: 'wh-ac-hint', text: o.note ?? NAME_HINT })]),
        el('div', 'wh-ac-setup-r', [animals, colors]),
      ]),
    );
    page.root.querySelector('.wh-ac-col')!.append(el('div', 'wh-ac-actions', [cancelBtn, okBtn]));
    draw();
    check();
    if (o.focus === 'name') window.setTimeout(() => input.focus({ preventScroll: true }), 50);
  });
}

/** "Who's playing?" for the first player / "Add a player": creates the profile (online only). */
export async function addPlayer(container: HTMLElement, cloud: Pick<CloudHandle, 'profiles'>, o: { first: boolean }): Promise<ProfileDto | null> {
  const taken = cloud.profiles.list().map((p) => p.avatar);
  let made: ProfileDto | null = null;
  const ok = await playerEditor(container, {
    title: o.first ? "Who's playing?" : 'Add a player',
    okLabel: o.first ? "Let's go!" : 'Add player',
    cancelLabel: o.first ? 'Not now' : 'Cancel',
    note: o.first ? `Make a player for each child. ${NAME_HINT}` : NAME_HINT,
    initial: { name: '', avatar: freshAvatar(taken, taken.length * 13 + 3) },
    focus: 'name',
    save: async (name, avatar) => {
      made = await cloud.profiles.create(name, avatar);
    },
  });
  return ok ? made : null;
}

/** Manage players: rename and / or change the animal. */
export function editPlayer(container: HTMLElement, cloud: Pick<CloudHandle, 'profiles'>, p: { id: string; name: string; avatar: Avatar }, focus: 'name' | 'animal'): Promise<boolean> {
  return playerEditor(container, {
    title: focus === 'name' ? `Rename ${p.name}` : `${p.name}'s animal`,
    okLabel: 'Save',
    cancelLabel: 'Cancel',
    initial: { name: p.name, avatar: p.avatar },
    focus,
    save: async (name, avatar) => {
      const n = checkName(name);
      if (n.ok && n.name !== p.name) await cloud.profiles.rename(p.id, n.name);
      if (avatar.animal !== p.avatar.animal || avatar.color !== p.avatar.color) await cloud.profiles.setAvatar(p.id, avatar);
    },
  });
}
