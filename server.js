const express = require('express');
const cors = require('cors');
const multer = require('multer');

const app = express();
app.use(cors());
app.use(express.json());

const upload = multer({ limits: { fileSize: 25 * 1024 * 1024 } });

function obtenirCleAPI(req) {
    const cleEleve = req.headers['x-custom-api-key'];
    if (cleEleve && cleEleve.trim().startsWith("AIzaSy")) return cleEleve.trim();
    return process.env.GEMINI_API_KEY;
}

const attendre = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function appelerGeminiAvecSecours(contents, modelPrefere, apiKey) {
    const modelesDisponibles = [
        modelPrefere || 'gemini-3.8-flash',
        'gemini-3.7-flash',
        'gemini-3.6-flash',
        'gemini-3.5-flash'
    ];
    const listeAtester = [...new Set(modelesDisponibles)];
    let journalErreurs = [];

    for (const modele of listeAtester) {
        for (let tentative = 1; tentative <= 2; tentative++) {
            try {
                const url = `https://generativelanguage.googleapis.com/v1beta/models/${modele}:generateContent?key=${apiKey}`;
                const response = await fetch(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        contents: contents,
                        generationConfig: { responseMimeType: "application/json" }
                    })
                });

                const data = await response.json();
                if (data.error) {
                    const code = data.error.code || response.status;
                    if ((code === 503 || code === 429) && tentative === 1) {
                        await attendre(2000);
                        continue;
                    }
                    journalErreurs.push(`${modele}: [Code ${code}] ${data.error.message}`);
                    break;
                }

                if (data.candidates && data.candidates[0].content.parts[0].text) {
                    let texte = data.candidates[0].content.parts[0].text;
                    texte = texte.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();
                    return JSON.parse(texte);
                }
            } catch (err) {
                journalErreurs.push(`${modele}: ${err.message}`);
                break;
            }
        }
    }
    throw new Error("Échec des modèles testés :\n" + journalErreurs.join("\n"));
}

// 1. ENDPOINT ANALYSE PDF (COURS & BLOCS)
app.post('/api/analyser-pdf', upload.single('pdf'), async (req, res) => {
    try {
        const apiKey = obtenirCleAPI(req);
        if (!apiKey) return res.status(500).json({ error: "Clé Gemini absente." });
        if (!req.file) return res.status(400).json({ error: "Aucun fichier PDF reçu." });

        const modelChoisi = req.headers['x-gemini-model'] || 'gemini-3.8-flash';
        const pdfBase64 = req.file.buffer.toString('base64');

        const prompt = `
Tu es un professeur de FLE pour apprenants coréens. Analyse ce document et structure-le en modules pédagogiques :
RÈGLE CRUCIALE : Chaque phrase à trous doit être ENTIÈRE jusqu'au point final. Si plusieurs verbes à conjuguer, conserve toute la phrase avec ses multiples "____".

Structure JSON :
{
  "titre": "Titre de la leçon",
  "bloc_cours": {
    "titre": "Cours de Grammaire",
    "slides": [ { "numero": 1, "titre": "Titre fiche", "contenu_coreen": "Explications..." } ]
  },
  "blocs_exercices": [
    {
      "id": "exo_1",
      "titre": "Titre exercice",
      "consigne": "Consigne",
      "questions": [ { "q": "Phrase avec ____ (verbe)" } ]
    }
  ]
}
`;
        const contents = [{ parts: [{ text: prompt }, { inline_data: { mime_type: "application/pdf", data: pdfBase64 } }] }];
        const resultatJson = await appelerGeminiAvecSecours(contents, modelChoisi, apiKey);
        res.json(resultatJson);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 2. ENDPOINT CHAT IA AJUSTEMENT PDF
app.post('/api/ajuster-contenu', async (req, res) => {
    try {
        const apiKey = obtenirCleAPI(req);
        const modelChoisi = req.headers['x-gemini-model'] || 'gemini-3.8-flash';
        const { contenuActuel, instruction } = req.body;

        const prompt = `
Tu es un professeur de FLE pour élèves coréens. Voici le cours actuel :
${JSON.stringify(contenuActuel, null, 2)}
INSTRUCTION DU PROFESSEUR : "${instruction}"
Renvoie UNIQUEMENT le JSON mis à jour :
`;
        const contents = [{ parts: [{ text: prompt }] }];
        const resultatJson = await appelerGeminiAvecSecours(contents, modelChoisi, apiKey);
        res.json(resultatJson);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 3. ENDPOINT LOUISON (CORRECTION PÉDAGOGIQUE STRICTE SILLYTAVERN)
app.post('/api/corriger-louison', async (req, res) => {
    try {
        const apiKey = obtenirCleAPI(req);
        if (!apiKey) return res.status(500).json({ error: "Clé Gemini absente." });

        const modelChoisi = req.headers['x-gemini-model'] || 'gemini-3.8-flash';
        const { question, reponseEleve } = req.body;

        if (!reponseEleve || !reponseEleve.trim()) {
            return res.json({
                reponse_amicale: "Tu n'as rien écrit ! N'aie pas peur d'essayer. 😊",
                ce_qui_est_bien: "Rien pour l'instant.",
                les_fautes: "La réponse est vide.",
                phrase_corrigee: "Écris une phrase complète.",
                ameliorations: "Lance-toi !"
            });
        }

        const prompt = `
Tu es Emma, une amie française bienveillante (A2-B1).
Tu dialogues avec un apprenant de français (niveau A1/A2).

Question posée : "${question}"
Phrase écrite par l'élève : "${reponseEleve}"

[INSTRUCTIONS RP]
- Ton : Amical, simple, chaleureux, naturel (Français A1/A2, pas d'argot).
- Rédige une réponse amicale et courte (1-2 phrases) en réagissant à ce qu'il a dit.

[INSTRUCTIONS DE CORRECTION - ANTI-HALLUCINATION STRICTE]
Tu es un correcteur JUSTE et PRÉCIS.
1. Regarde VRAIMENT la phrase de l'élève.
2. Si la 1ère lettre est une majuscule -> INTERDICTION ABSOLUE de dire qu'elle manque.
3. Si le dernier caractère est un point (.) ou point d'interrogation (?) -> INTERDICTION de dire qu'il manque.
4. Ne corrige que les VRAIES fautes (grammaire, conjugaison, orthographe, virgule obligatoire après Oui/Non).
5. SI LA PHRASE EST CORRECTE : Dans "les_fautes", écris "Aucune faute majeure !". Ne cherche pas la petite bête.

Renvoie UNIQUEMENT un objet JSON respectant cette structure exacte :
{
  "reponse_amicale": "Réponse amicale et naturelle de Emma...",
  "ce_qui_est_bien": "Ce qui est réussi (ex: Bonne conjugaison, vocabulaire pertinent)...",
  "les_fautes": "Les fautes réelles ou 'Aucune faute majeure !'...",
  "phrase_corrigee": "La phrase complète corrigée...",
  "ameliorations": "Conseil d'amélioration ou 'Rien d'autre, c'est très bien !'..."
}
`;

        const contents = [{ parts: [{ text: prompt }] }];
        const resultatJson = await appelerGeminiAvecSecours(contents, modelChoisi, apiKey);
        res.json(resultatJson);

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Serveur French API actif sur le port ${PORT}`));
