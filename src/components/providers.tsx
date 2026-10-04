"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
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
  // Music is on by default; the stored value only records an explicit opt-out.
  const [musicEnabled, setMusicEnabled] = useState(true);
  const [notifyEnabled, setNotifyEnabled] = useState(false);
  const soundEnabledRef = useRef(soundEnabled);
  const musicEnabledRef = useRef(musicEnabled);
  const notifyEnabledRef = useRef(notifyEnabled);

  useEffect(() => {
    // Preferences are read after mount on purpose: reading localStorage during
    // render would produce a server/client hydration mismatch.
    /* eslint-disable react-hooks/set-state-in-effect */
    const storedTheme = window.localStorage.getItem("cd.theme");
    if (isThemeId(storedTheme)) setThemeState(storedTheme);
    const storedSound = window.localStorage.getItem("cd.sound");
    if (storedSound === "off") setSoundEnabled(false);
    setMusicEnabled(window.localStorage.getItem("cd.music") !== "off");
    setNotifyEnabled(window.localStorage.getItem("cd.notify") === "on");
    /* eslint-enable react-hooks/set-state-in-effect */
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    window.localStorage.setItem("cd.theme", theme);
  }, [theme]);

  useEffect(() => {
    soundEnabledRef.current = soundEnabled;
    musicEnabledRef.current = musicEnabled;
  }, [musicEnabled, soundEnabled]);

  useEffect(() => {
    // One place owns the engine state: master sound, then music. Running both
    // here (and never inside a state updater) keeps React StrictMode's double
    // invocation from starting two music beds.
    sound.setEnabled(soundEnabled);
    sound.setMusicEnabled(soundEnabled && musicEnabled);
    window.localStorage.setItem("cd.sound", soundEnabled ? "on" : "off");
    window.localStorage.setItem("cd.music", musicEnabled ? "on" : "off");
  }, [musicEnabled, soundEnabled]);

  const setTheme = useCallback((next: ThemeId) => {
    if (THEMES.includes(next)) setThemeState(next);
  }, []);

  const toggleSound = useCallback(() => {
    const next = !soundEnabledRef.current;
    soundEnabledRef.current = next;
    sound.setEnabled(next);
    if (next) {
      // This is a real gesture, so the context can be unlocked and acknowledged.
      sound.unlock();
      sound.play("ui");
    }
    setSoundEnabled(next);
  }, []);

  const toggleMusic = useCallback(() => {
    const next = !musicEnabledRef.current;
    musicEnabledRef.current = next;
    sound.setMusicEnabled(next && sound.enabled);
    window.localStorage.setItem("cd.music", next ? "on" : "off");
    setMusicEnabled(next);
  }, []);

  const toggleNotify = useCallback(() => {
    const next = !notifyEnabledRef.current;
    notifyEnabledRef.current = next;
    window.localStorage.setItem("cd.notify", next ? "on" : "off");
    if (next && typeof Notification !== "undefined" && Notification.permission === "default") {
      void Notification.requestPermission();
    }
    setNotifyEnabled(next);
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
