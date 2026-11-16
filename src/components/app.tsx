"use client";

import { useCallback, useEffect, useState } from "react";
import { type Settings, isReady, loadSettings, saveSettings } from "@/lib/client/settings";
import { beginLogin, getAccessToken, hasSession, signOut } from "@/lib/client/spotify-auth";
import { Chat } from "./chat";
import { Landing } from "./landing";

interface Profile {
  name: string;
  image: string | null;
}

export function App() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [connected, setConnected] = useState(false);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    // Spotify only accepts loopback-IP redirect URIs, and storage is per-origin: settle on 127.0.0.1.
    if (window.location.hostname === "localhost") {
      window.location.replace(window.location.href.replace("//localhost", "//127.0.0.1"));
      return;
    }
    const s = loadSettings();
    setSettings(s);
    setConnected(isReady(s) && hasSession(s.spotifyClientId));
  }, []);

  const disconnect = useCallback((message: string | null = null) => {
    signOut();
    setConnected(false);
    setProfile(null);
    setNotice(message);
  }, []);

  useEffect(() => {
    if (!connected) return;
    let cancelled = false;
    (async () => {
      try {
        const token = await getAccessToken();
        if (!token) return disconnect("Your Spotify connection expired. Connect again to keep going.");
        const res = await fetch("https://api.spotify.com/v1/me", { headers: { Authorization: `Bearer ${token}` } });
        if (res.status === 401) return disconnect("Your Spotify connection expired. Connect again to keep going.");
        if (res.status === 403) {
          return disconnect(
            "Spotify blocked this account for your app. In the Spotify dashboard, add your account under User Management, then connect again.",
          );
        }
        const me = await res.json();
        if (!cancelled) setProfile({ name: me.display_name || me.id || "You", image: me.images?.[0]?.url ?? null });
      } catch {
        if (!cancelled) setProfile({ name: "You", image: null });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [connected, disconnect]);

  const connect = (next: Settings) => {
    saveSettings(next);
    setSettings(next);
    void beginLogin(next.spotifyClientId);
  };

  const updateSettings = (next: Settings) => {
    saveSettings(next);
    setSettings(next);
    // A different Spotify app means the stored tokens no longer apply.
    if (!hasSession(next.spotifyClientId)) disconnect("You changed the Spotify Client ID. Connect again with the new app.");
  };

  if (!settings) return null;

  if (!connected) return <Landing settings={settings} notice={notice} onConnect={connect} />;

  return (
    <Chat
      user={profile ?? { name: "", image: null }}
      settings={settings}
      onSettingsChange={updateSettings}
      onDisconnect={() => disconnect()}
      onReconnect={() => void beginLogin(settings.spotifyClientId)}
    />
  );
}
