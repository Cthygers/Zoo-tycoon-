// Read-aloud for the tutorial (spec §6.7): on Android the @capacitor-community/text-to-speech
// plugin (the System WebView has no speechSynthesis), loaded on first use; in browsers the Web
// Speech API. When neither has a voice, the speaker toggle is hidden everywhere.

export interface Speech {
  /** Resolves once whether a voice exists is known. */
  available(): Promise<boolean>;
  /** Known availability (null while still checking). */
  readonly ready: boolean | null;
  speak(text: string): void;
  stop(): void;
  /** Called with true while speaking, false when done (the audio round ducks the game under it). */
  onSpeaking: ((on: boolean) => void) | null;
}

type TtsPlugin = {
  speak(o: { text: string; lang?: string; rate?: number; pitch?: number; volume?: number; queueStrategy?: number }): Promise<void>;
  stop(): Promise<void>;
  isLanguageSupported(o: { lang: string }): Promise<{ supported: boolean }>;
};

function isNative(): boolean {
  const cap = (globalThis as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor;
  try {
    return !!cap?.isNativePlatform?.();
  } catch {
    return false;
  }
}

class NativeSpeech implements Speech {
  ready: boolean | null = null;
  onSpeaking: ((on: boolean) => void) | null = null;
  private plugin: Promise<TtsPlugin | null> | null = null;
  private check: Promise<boolean> | null = null;
  private token = 0;

  private load(): Promise<TtsPlugin | null> {
    this.plugin ??= import('@capacitor-community/text-to-speech').then(
      (m) => m.TextToSpeech as unknown as TtsPlugin,
      () => null,
    );
    return this.plugin;
  }

  available(): Promise<boolean> {
    this.check ??= this.load()
      .then((p) => (p ? p.isLanguageSupported({ lang: 'en-US' }).then((r) => !!r.supported) : false))
      .catch(() => false)
      .then((ok) => (this.ready = ok));
    return this.check;
  }

  speak(text: string): void {
    const t = ++this.token;
    void this.load().then((p) => {
      if (!p || t !== this.token) return;
      this.onSpeaking?.(true);
      p.speak({ text, lang: 'en-US', rate: 0.95, pitch: 1.05, queueStrategy: 0 })
        .catch(() => undefined)
        .then(() => {
          if (t === this.token) this.onSpeaking?.(false);
        });
    });
  }

  stop(): void {
    this.token++;
    void this.plugin?.then((p) => p?.stop().catch(() => undefined));
    this.onSpeaking?.(false);
  }
}

class WebSpeech implements Speech {
  ready: boolean | null = null;
  onSpeaking: ((on: boolean) => void) | null = null;
  private check: Promise<boolean> | null = null;
  private synth: SpeechSynthesis | null = typeof speechSynthesis !== 'undefined' ? speechSynthesis : null;
  private speaking = false;

  available(): Promise<boolean> {
    this.check ??= new Promise<boolean>((resolve) => {
      const s = this.synth;
      if (!s || typeof SpeechSynthesisUtterance === 'undefined') return resolve(false);
      const has = () => {
        try {
          return s.getVoices().length > 0;
        } catch {
          return false;
        }
      };
      if (has()) return resolve(true);
      let done = false;
      const fin = (v: boolean) => {
        if (done) return;
        done = true;
        resolve(v);
      };
      try {
        s.addEventListener('voiceschanged', () => fin(has()), { once: true });
      } catch {
        /* old engines */
      }
      setTimeout(() => fin(has()), 1500);
    }).then((ok) => (this.ready = ok));
    return this.check;
  }

  private voice(): SpeechSynthesisVoice | null {
    try {
      const v = this.synth?.getVoices() ?? [];
      return v.find((x) => /^en[-_](US|GB)/i.test(x.lang) && x.localService) ?? v.find((x) => /^en/i.test(x.lang)) ?? v[0] ?? null;
    } catch {
      return null;
    }
  }

  speak(text: string): void {
    const s = this.synth;
    if (!s) return;
    try {
      s.cancel();
      const u = new SpeechSynthesisUtterance(text);
      const v = this.voice();
      try {
        if (v) u.voice = v;
      } catch {
        /* an engine that refuses the voice object: its default voice */
      }
      u.lang = v?.lang ?? 'en-US';
      u.rate = 0.95;
      u.pitch = 1.05;
      u.onend = u.onerror = () => {
        if (this.speaking) {
          this.speaking = false;
          this.onSpeaking?.(false);
        }
      };
      this.speaking = true;
      this.onSpeaking?.(true);
      s.speak(u);
    } catch {
      /* speech unavailable */
    }
  }

  stop(): void {
    try {
      this.synth?.cancel();
    } catch {
      /* ignore */
    }
    if (this.speaking) {
      this.speaking = false;
      this.onSpeaking?.(false);
    }
  }
}

class NoSpeech implements Speech {
  ready = false;
  onSpeaking: ((on: boolean) => void) | null = null;
  available(): Promise<boolean> {
    return Promise.resolve(false);
  }
  speak(): void {}
  stop(): void {}
}

/** The read-aloud adapter for this platform. */
export function createSpeech(): Speech {
  if (isNative()) return new NativeSpeech();
  if (typeof window !== 'undefined' && typeof speechSynthesis !== 'undefined') return new WebSpeech();
  return new NoSpeech();
}

/** What the bubble reads: the action line, then the why line. */
export function speechText(a: string, w?: string | null): string {
  return w ? `${a} ${w}` : a;
}
