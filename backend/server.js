// backend/server.js
import "dotenv/config";
import express from "express";
import cors from "cors";
import SpotifyWebApi from "spotify-web-api-node";
import { GoogleGenerativeAI } from "@google/generative-ai";

const app = express();
app.use(cors());
app.use(express.json());

// ------------------ CONFIGURAÇÕES ------------------

// Spotify (Padronizado para localhost)
const spotifyApi = new SpotifyWebApi({
    clientId: process.env.SPOTIFY_CLIENT_ID,
    clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
    redirectUri: "http://127.0.0.1:3001/callback" // MUDE PARA 127.0.0.1
});

// Gemini AI
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Função auxiliar para evitar bloqueio do Spotify (Rate Limit)
const delay = (ms) => new Promise(res => setTimeout(res, ms));


// ------------------ ROTAS ------------------

// Login Spotify
// Login Spotify (Bypass da Biblioteca)
// Login Spotify Seguro e Blindado
app.get("/login", (req, res) => {
    const scopes = [
        "user-read-private",
        "user-read-email",
        "playlist-modify-private",
        "playlist-modify-public"
    ];
    // O "true" força a tela verde a pedir permissão de novo
    res.redirect(spotifyApi.createAuthorizeURL(scopes, "teste", true));
});

// Callback Spotify
app.get("/callback", async (req, res) => {
    try {
        const code = req.query.code;
        const data = await spotifyApi.authorizationCodeGrant(code);

        spotifyApi.setAccessToken(data.body.access_token);
        spotifyApi.setRefreshToken(data.body.refresh_token);

        console.log("✅ Login no Spotify realizado com sucesso!");

        // Retorna para o React avisando que logou com sucesso
        res.redirect("http://127.0.0.1:5173/?logado=true"); // MUDE PARA 127.0.0.1
    } catch (err) {
        console.error("Erro no callback do Spotify:", err);
        res.status(500).send("Erro ao tentar logar no Spotify. Tente novamente.");
    }
});

// Gerar músicas via Gemini
app.post("/generate", async (req, res) => {
    try {
        const { prompt } = req.body;
        if (!prompt || prompt.trim() === "") {
            return res.status(400).json({ error: "Prompt vazio" });
        }

        // Usando o modelo mais atualizado que funcionou para você
        const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

        // Separa o pedido do usuário das regras estritas de formatação do nosso sistema
        const geminiPrompt = `Aja como um especialista musical. Atenda ao seguinte pedido do usuário: 
        "${prompt}"
        
        ATENÇÃO - REGRAS ESTRITAS DE FORMATAÇÃO PARA A RESPOSTA:
        1. Retorne APENAS a lista de músicas reais solicitadas.
        2. O formato de CADA linha deve ser estritamente: Nome da Música - Nome do Artista.
        3. Retorne apenas uma música por linha.
        4. NÃO use numeração (1., 2., etc).
        5. NÃO use asteriscos, negrito ou qualquer markdown.
        6. NÃO escreva nenhum texto adicional antes ou depois da lista.`;

        const result = await model.generateContent(geminiPrompt);
        const text = result.response.text();

        const tracks = text
            .split("\n")
            .map(track => track.replace(/^\d+\.\s*/, '').trim()) // Remove números caso o Gemini insista em colocar
            .filter(Boolean);

        if (!tracks || tracks.length === 0) {
            return res.status(500).json({ error: "Resposta vazia do Gemini AI" });
        }

        res.json({ tracks });
    } catch (err) {
        console.error("Erro no Gemini:", err);
        res.status(500).json({ error: "Erro Gemini AI", details: err.message });
    }
});

// Criar playlist Spotify
// Criar playlist Spotify (Bypass Total)
// Criar playlist Spotify (O Híbrido Perfeito)
app.post("/create-playlist", async (req, res) => {
    try {
        if (!spotifyApi.getAccessToken()) {
            return res.status(401).json({ error: "Faça o login no Spotify primeiro!" });
        }

        const { tracks, name } = req.body;
        if (!tracks || tracks.length === 0) {
            return res.status(400).json({ error: "Nenhuma música fornecida" });
        }

        console.log("1. Buscando o ID real do seu usuário (Via Biblioteca)...");
        const me = await spotifyApi.getMe();
        const userId = me.body.id;
        console.log(`👤 ID Oficial: ${userId}`);

        console.log(`2. Criando a playlist "${name}" (Via Biblioteca - Como funcionava antes!)...`);
        let playlist;
        try {
            // Como funcionava perfeitamente antes:
            playlist = await spotifyApi.createPlaylist(name || "AI Playlist", {
                description: "Playlist gerada com a inteligência do Gemini! 🤖",
                public: true
            });
        } catch (err) {
            playlist = await spotifyApi.createPlaylist(userId, name || "AI Playlist", { public: false });
        }

        const playlistId = playlist.body.id;
        console.log(`✅ Playlist criada com ID: ${playlistId}`);

        console.log("3. Buscando músicas no Spotify (O robô agora respeita os semáforos)...");
        const uris = [];

        // O seu buscador blindado maravilhoso
        for (let t of tracks) {
            let tentou = false;
            while (!tentou) {
                try {
                    let cleanQuery = t.replace(/-/g, ' ').replace(/["']/g, '').replace(/\bde\b/gi, '').replace(/[()[\]]/g, '').trim();
                    const result = await spotifyApi.searchTracks(cleanQuery, { limit: 1 });
                    if (result.body.tracks && result.body.tracks.items.length > 0) {
                        uris.push(result.body.tracks.items[0].uri);
                    } else {
                        const fallback = await spotifyApi.searchTracks(t, { limit: 1 });
                        if (fallback.body.tracks && fallback.body.tracks.items.length > 0) {
                            uris.push(fallback.body.tracks.items[0].uri);
                        }
                    }
                    tentou = true;
                    await delay(300);
                } catch (searchErr) {
                    const status = searchErr.statusCode;
                    if (status === 429) {
                        const tempoEspera = searchErr.headers['retry-after'] ? parseInt(searchErr.headers['retry-after']) : 5;
                        console.log(`🚦 Pausando por ${tempoEspera}s antes de tentar "${t}"...`);
                        await delay(tempoEspera * 1000);
                    } else {
                        console.log(`⚠️ Desisti da música "${t}"`);
                        tentou = true;
                    }
                }
            }
        }

        if (uris.length === 0) {
            return res.status(404).json({ error: "O Spotify não encontrou as músicas." });
        }

        console.log(`\n--- 🕵️ INÍCIO DO DEBUG DA INSERÇÃO ---`);
        console.log(`📍 Playlist ID Alvo: ${playlistId}`);

        const token = spotifyApi.getAccessToken();
        console.log(`🔑 Token de Acesso (primeiros 15 chars): ${token ? token.substring(0, 15) + '...' : 'VAZOU/AUSENTE!'}`);
        console.log(`📦 Total de URIs capturadas: ${uris.length}`);

        if (uris.length > 0) {
            console.log(`🎵 Exemplo de URI da música 1: ${uris[0]}`);
        }

        // O link oficial (você já provou que o seu está certinho!)
        const API_BASE = "https://api.spotify.com/v1";
        const tamanhoLote = 99; // O Spotify aceita até 100, mas vamos usar 40 para garantir

        for (let i = 0; i < uris.length; i += tamanhoLote) {
            const lote = uris.slice(i, i + tamanhoLote);

            // Seguindo exatamente o endpoint da documentação
            const endpoint = `${API_BASE}/playlists/${playlistId}/tracks`;

            console.log(`\n🚀 Enviando Lote ${i / tamanhoLote} (Posição inicial: ${i}) seguindo a documentação...`);

            const addRes = await fetch(endpoint, {
                method: "POST",
                headers: {
                    "Authorization": `Bearer ${token}`,
                    "Content-Type": "application/json" // 👈 Exigido pela documentação!
                },
                body: JSON.stringify({
                    uris: lote,
                    position: i // 👈 O segredo da documentação! (0, 40, 80...)
                })
            });

            if (!addRes.ok) {
                const erroCru = await addRes.text();
                console.error(`❌ O Spotify bloqueou a inserção do formato. ERRO:`, erroCru);
                return res.status(403).json({ error: "Bloqueio persistente no Spotify." });
            }

            tracksAdicionadas += lote.length;
            console.log(`✅ Lote inserido com sucesso! (${tracksAdicionadas}/${uris.length})`);

            // Respiro para o servidor do Spotify
            await delay(1000);
        }
        console.log(`\n--- 🏁 FIM DO DEBUG DA INSERÇÃO COM SUCESSO ---`);
        res.json({ success: true, playlistId: playlistId, tracksFound: tracksAdicionadas });

    } catch (err) {
        console.error("❌ Erro fatal:", err.message);
        res.status(500).json({ error: "Erro interno no servidor." });
    }
});
// Start server
app.listen(3001, () => console.log("Servidor rodando em http://127.0.0.1:3001"));