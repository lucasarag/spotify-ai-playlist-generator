// frontend/App.jsx
import { useState, useEffect } from "react";

export default function App() {
  const [prompt, setPrompt] = useState("");
  const [tracks, setTracks] = useState([]);
  const [loading, setLoading] = useState(false);
  const [isLogged, setIsLogged] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  
  // 👉 NOVO: Estado para guardar o nome da playlist
  const [playlistName, setPlaylistName] = useState("");

  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get("logado") === "true") {
      setIsLogged(true);
      window.history.replaceState({}, document.title, "/");
    }
  }, []);

  const loginSpotify = () => {
    window.location.href = "http://127.0.0.1:3001/login";
  };

  const generate = async () => {
    setLoading(true);
    setTracks([]);
    try {
      const res = await fetch("http://127.0.0.1:3001/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt }),
      });

      if (!res.ok) {
        const err = await res.json();
        alert("Erro ao gerar músicas: " + (err.error || res.status));
        setLoading(false);
        return;
      }

      const data = await res.json();
      setTracks(data.tracks || []);
    } catch (err) {
      console.error(err);
      alert("Erro de rede ao conectar com o Gemini.");
    } finally {
      setLoading(false);
    }
  };

  const createPlaylist = async () => {
    if (tracks.length === 0) return;
    setIsCreating(true);
    
    // 👉 NOVO: Lógica que verifica se o nome está vazio e coloca o genérico
    const finalName = playlistName.trim() !== "" ? playlistName : "AI PLAYLIST";

    try {
      const res = await fetch("http://127.0.0.1:3001/create-playlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tracks, name: finalName }), // Envia o nome final
      });

      const data = await res.json();
      if (data.success) {
        alert(`Sucesso! Playlist "${finalName}" criada com ${data.tracksFound} músicas no seu Spotify! 🎧`);
        setTracks([]); 
        setPrompt("");
        setPlaylistName(""); // Limpa o campo do nome
      } else {
        alert("Erro ao criar playlist: " + (data.error || ""));
      }
    } catch (err) {
      console.error(err);
      alert("Erro de rede ao criar playlist.");
    } finally {
      setIsCreating(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-black via-gray-900 to-black text-white flex flex-col items-center justify-center p-4">
      <h1 className="text-4xl font-bold mb-8 text-transparent bg-clip-text bg-gradient-to-r from-green-400 to-blue-500">
        AI Playlist Generator
      </h1>
      
      {!isLogged ? (
        <button
          onClick={loginSpotify}
          className="bg-[#1DB954] hover:bg-[#1ed760] text-black p-4 rounded-xl font-bold mb-8 transition w-full max-w-lg shadow-lg"
        >
          1. Conectar com o Spotify
        </button>
      ) : (
        <div className="bg-green-500/20 text-green-400 border border-green-500/50 p-3 rounded-xl mb-8 w-full max-w-lg text-center font-semibold">
          ✅ Spotify Conectado!
        </div>
      )}

      <div className={`w-full max-w-lg transition-opacity ${!isLogged ? 'opacity-30 pointer-events-none' : 'opacity-100'}`}>
        <textarea
          rows="3"
          placeholder="Ex: 100 aberturas de animes shonen (Naruto, Bleach, etc)..."
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          className="p-4 rounded-xl w-full text-black mb-4 outline-none focus:ring-2 focus:ring-green-500 resize-none"
        />
        
        <button
          onClick={generate}
          disabled={loading || !prompt.trim()}
          className={`bg-blue-600 hover:bg-blue-700 p-4 rounded-xl font-bold mb-4 transition w-full shadow-lg ${loading || !prompt.trim() ? "opacity-50 cursor-not-allowed" : ""}`}
        >
          {loading ? "✨ Pensando e buscando..." : "2. Gerar Músicas"}
        </button>
      </div>

      <div className="max-w-lg w-full mt-2 mb-4 max-h-64 overflow-y-auto rounded-lg custom-scrollbar">
        {tracks.length > 0 && (
          <div className="bg-gray-800/50 rounded-lg p-2">
            {tracks.map((t, i) => (
              <div key={i} className="p-3 border-b border-white/5 hover:bg-white/10 text-sm transition last:border-0">
                {i + 1}. {t}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 👉 NOVO: Campo de Nome da Playlist e Botão Final */}
      {tracks.length > 0 && (
        <div className="w-full max-w-lg mt-2 bg-gray-800/80 p-4 rounded-xl border border-white/10">
          <label className="block text-sm text-gray-400 mb-2 font-semibold">Nome da Playlist (Opcional):</label>
          <input
            type="text"
            placeholder="Ex: Melhores Animes 🎌"
            value={playlistName}
            onChange={(e) => setPlaylistName(e.target.value)}
            className="p-3 rounded-lg w-full text-black mb-4 outline-none focus:ring-2 focus:ring-green-500"
            maxLength={100} // Proteção nativa do HTML para não passar de 100 caracteres
          />

          <button
            onClick={createPlaylist}
            disabled={isCreating}
            className={`bg-green-500 hover:bg-green-600 text-black transition p-4 rounded-xl font-bold w-full shadow-lg ${isCreating ? "opacity-50 cursor-not-allowed animate-pulse" : ""}`}
          >
            {isCreating ? "Montando no Spotify..." : "3. Criar Playlist Agora!"}
          </button>
        </div>
      )}
    </div>
  );
}