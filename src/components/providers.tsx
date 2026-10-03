"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { THEMES, isThemeId, type ThemeId } from "@/lib/config/themes";
import { sound, type SoundCue } from "@/lib/sound/audio";

interface PreferencesValue {
  theme: ThemeId;
  setTheme: (theme: ThemeId) => void;
  soundEnabled: boolean;
  toggleSound: () => void;
  musicEnabled: boolean;
  toggleMusic: () => void;
  notifyEnabled: boolean;
  toggleNotify: () => void;
  play: (cue: SoundCue) => void;
}

const PreferencesContext = createContext<PreferencesValue | null>(null);

export function usePreferences(): PreferencesValue {
  const value = useContext(PreferencesContext);
  if (!value) throw new Error("usePreferences must be used inside PreferencesProvider");
  return value;
}

export function PreferencesProvider({
  children,
  initialTheme = "neon",
}: {
  children: React.ReactNode;
  initialTheme?: ThemeId;
}) {
  const [theme, setThemeState] = useState<ThemeId>(initialTheme);
  const [soundEnabled, setSoundEnabled] = useState(true);
  const [musicEnabled, setMusicEnabled] = useState(false);
  const [notifyEnabled, setNotifyEnabled] = useState(false);

  useEffect(() => {
    // Preferences are read after mount on purpose: reading localStorage during
    // render would produce a server/client hydration mismatch.
    /* eslint-disable react-hooks/set-state-in-effect */
    const storedTheme = window.localStorage.getItem("cd.theme");
    if (isThemeId(storedTheme)) setThemeState(storedTheme);
    const storedSound = window.localStorage.getItem("cd.sound");
    if (storedSound === "off") setSoundEnabled(false);
    setMusicEnabled(window.localStorage.getItem("cd.music") === "on");
    setNotifyEnabled(window.localStorage.getItem("cd.notify") === "on");
    /* eslint-enable react-hooks/set-state-in-effect */
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    window.localStorage.setItem("cd.theme", theme);
  }, [theme]);

  useEffect(() => {
    sound.setEnabled(soundEnabled);
    if (!soundEnabled) sound.setMusicEnabled(false);
    else if (musicEnabled) sound.setMusicEnabled(true);
    window.localStorage.setItem("cd.sound", soundEnabled ? "on" : "off");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [soundEnabled]);

  const setTheme = useCallback((next: ThemeId) => {
    if (THEMES.includes(next)) setThemeState(next);
  }, []);

  const toggleSound = useCallback(() => {
    setSoundEnabled((previous) => {
      const next = !previous;
      sound.setEnabled(next);
      if (next) sound.play("ui");
      return next;
    });
  }, []);

  const toggleMusic = useCallback(() => {
    setMusicEnabled((previous) => {
      const next = !previous;
      sound.setMusicEnabled(next && sound.enabled);
      window.localStorage.setItem("cd.music", next ? "on" : "off");
      return next;
    });
  }, []);

  const toggleNotify = useCallback(() => {
    setNotifyEnabled((previous) => {
      const next = !previous;
      window.localStorage.setItem("cd.notify", next ? "on" : "off");
      if (next && typeof Notification !== "undefined" && Notification.permission === "default") {
        void Notification.requestPermission();
      }
      return next;
    });
  }, []);

  const play = useCallback((cue: SoundCue) => sound.play(cue), []);

  const value = useMemo(
    () => ({
      theme,
      setTheme,
      soundEnabled,
      toggleSound,
      musicEnabled,
      toggleMusic,
      notifyEnabled,
      toggleNotify,
      play,
    }),
    [theme, setTheme, soundEnabled, toggleSound, musicEnabled, toggleMusic, notifyEnabled, toggleNotify, play],
  );

  return <PreferencesContext.Provider value={value}>{children}</PreferencesContext.Provider>;
}

export interface SessionProfileValue {
  authenticated: boolean;
  userId: string | null;
  username: string | null;
  walletAddress: string | null;
  custody: "external" | "managed" | null;
  isAdmin: boolean;
  rating: number;
  onboardingComplete: boolean;
}

const SessionContext = createContext<SessionProfileValue>({
  authenticated: false,
  userId: null,
  username: null,
  walletAddress: null,
  custody: null,
  isAdmin: false,
  rating: 1000,
  onboardingComplete: false,
});

export function SessionProvider({
  value,
  children,
}: {
  value: SessionProfileValue;
  children: React.ReactNode;
}) {
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionProfileValue {
  return useContext(SessionContext);
}
