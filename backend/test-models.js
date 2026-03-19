import "dotenv/config";

async function listarModelos() {
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    console.error("❌ Chave de API não encontrada no .env!");
    return;
  }

  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${key}`);
    const data = await res.json();
    
    if (data.error) {
      console.error("❌ Erro na API:", data.error.message);
      return;
    }

    console.log("✅ Modelos disponíveis para a SUA chave:");
    data.models.forEach(m => {
      // Mostra apenas os modelos que servem para gerar texto
      if (m.supportedGenerationMethods.includes("generateContent")) {
        console.log(`👉 ${m.name.replace('models/', '')}`);
      }
    });
  } catch (err) {
    console.error("❌ Erro ao conectar:", err.message);
  }
}

listarModelos();