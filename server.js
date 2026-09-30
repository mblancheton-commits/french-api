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
    throw new Error("Échec de tous les modèles testés :\n" + journalErreurs.join("\n"));
}

// ENDPOINT 1 : ANALYSE DU PDF EN BLOCS STRUCTURÉS (1 BLOC COURS + N BLOCS EXERCICES)
app.post('/api/analyser-pdf', upload.single('pdf'), async (req, res) => {
    try {
        const apiKey = obtenirCleAPI(req);
        if (!apiKey) return res.status(500).json({ error: "Clé Gemini absente." });
        if (!req.file) return res.status(400).json({ error: "Aucun fichier PDF reçu." });

        const modelChoisi = req.headers['x-gemini-model'] || 'gemini-3.8-flash';
        const pdfBase64 = req.file.buffer.toString('base64');

        const prompt = `
Tu es un professeur de FLE pour apprenants coréens. Analyse ce document et structure-le en modules/blocs indépendants :

1. "titre" : Titre global de la leçon.
2. "bloc_cours" :
   - Contient un tableau "slides" de fiches de grammaire courtes (1 seule règle par fiche).
   - Rédigé EN CORÉEN structuré et pédagogique avec exemples bilingues français/coréen.
3. "blocs_exercices" :
   - Crée UN BLOC DISTINCT pour CHAQUE exercice présent dans le document (ex: Exercice 1, Exercice 2, etc.).
   - Pour chaque bloc, indique : "id" (ex: "exo_1", "exo_2"), "titre", "consigne" et la liste de "questions".
   - Si phrases à compléter : utilise "____".
   - Si questions de rédaction/conversation : consigne claire.

Renvoie UNIQUEMENT un JSON strict :
{
  "titre": "Titre de la leçon",
  "bloc_cours": {
    "titre": "Cours de Grammaire",
    "slides": [
      { "numero": 1, "titre": "Titre fiche", "contenu_coreen": "Explications..." }
    ]
  },
  "blocs_exercices": [
    {
      "id": "exo_1",
      "titre": "Exercice 1 : Répondre à la forme négative",
      "consigne": "Répondez aux questions par une phrase complète à la forme négative.",
      "questions": [
        { "q": "Tu vas aller où pendant les vacances ?" }
      ]
    },
    {
      "id": "exo_2",
      "titre": "Exercice 2 : Réponses courtes",
      "consigne": "Répondez avec des réponses courtes (Moi aussi, Pas moi, etc.).",
      "questions": [
        { "q": "Je n'aime pas étudier." }
      ]
    }
  ]
}
`;

        const contents = [{
            parts: [
                { text: prompt },
                { inline_data: { mime_type: "application/pdf", data: pdfBase64 } }
            ]
        }];

        const resultatJson = await appelerGeminiAvecSecours(contents, modelChoisi, apiKey);
        res.json(resultatJson);

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ENDPOINT 2 : CHAT IA POUR AJUSTER LE CONTENU
app.post('/api/ajuster-contenu', async (req, res) => {
    try {
        const apiKey = obtenirCleAPI(req);
        const modelChoisi = req.headers['x-gemini-model'] || 'gemini-3.8-flash';
        const { contenuActuel, instruction } = req.body;

        const prompt = `
Tu es un professeur de FLE pour élèves coréens.
Voici le cours actuel découpé en bloc cours et blocs d'exercices :
${JSON.stringify(contenuActuel, null, 2)}

INSTRUCTION DU PROFESSEUR :
"${instruction}"

Modifie le contenu selon la demande en conservant la structure JSON exacte (titre, bloc_cours, blocs_exercices).
Renvoie UNIQUEMENT le JSON mis à jour :
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
