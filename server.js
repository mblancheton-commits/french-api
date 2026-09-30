const express = require('express');
const cors = require('cors');
const multer = require('multer');

const app = express();
app.use(cors());
app.use(express.json());

const upload = multer({ limits: { fileSize: 25 * 1024 * 1024 } });

// Fonction pour déterminer la clé API (celle de l'élève si transmise, sinon celle du prof)
function obtenirCleAPI(req) {
    const cleEleve = req.headers['x-custom-api-key'];
    if (cleEleve && cleEleve.trim().startsWith("AIzaSy")) return cleEleve.trim();
    return process.env.GEMINI_API_KEY;
}

// FONCTION AVEC RÉESSAI AUTOMATIQUE (FALLBACK) SUR LES MODÈLES GEMINI
async function appelerGeminiAvecSecours(contents, modelPrefere, apiKey) {
    // Liste des modèles dans l'ordre de priorité
    const modelesFallback = [
        modelPrefere || 'gemini-3.8-flash',
        'gemini-3.7-flash',
        'gemini-2.0-flash',
        'gemini-1.5-flash'
    ];
    // Éliminer les doublons
    const modelesAtester = [...new Set(modelesFallback)];

    let derniereErreur = null;

    for (const modele of modelesAtester) {
        try {
            console.log(`Tentative avec le modèle : ${modele}...`);
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

            // Si Google renvoie une erreur de modèle indisponible ou quota
            if (data.error) {
                console.warn(`Modèle ${modele} a échoué : ${data.error.message}. Bascule sur le modèle de secours...`);
                derniereErreur = data.error.message;
                continue; // Passer au modèle suivant
            }

            if (data.candidates && data.candidates[0].content.parts[0].text) {
                let texte = data.candidates[0].content.parts[0].text;
                texte = texte.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();
                return JSON.parse(texte);
            }
        } catch (err) {
            console.warn(`Erreur réseau avec ${modele} : ${err.message}. Test du modèle suivant...`);
            derniereErreur = err.message;
        }
    }

    throw new Error("Tous les modèles Gemini ont échoué. Dernière erreur : " + derniereErreur);
}

// 1. ENDPOINT ANALYSE PDF (COURS EN MICRO-FICHES + EXERCICES SÉPARÉS)
app.post('/api/analyser-pdf', upload.single('pdf'), async (req, res) => {
    try {
        const apiKey = obtenirCleAPI(req);
        if (!apiKey) return res.status(500).json({ error: "Aucune clé API Gemini configurée." });
        if (!req.file) return res.status(400).json({ error: "Aucun fichier PDF reçu." });

        const modelChoisi = req.headers['x-gemini-model'] || 'gemini-3.8-flash';
        const pdfBase64 = req.file.buffer.toString('base64');

        const prompt = `
Tu es un professeur de FLE pour apprenants coréens. Analyse ce document PDF et sépare STRICTEMENT le cours théorique et les exercices :

RÈGLES IMPORTANTES :
1. "slides_cours" (Micro-learning) :
   - Découpe la grammaire en MICRO-FICHES ATOMIQUES (1 règle ou 1 nuance par slide).
   - Ne fais JAMAIS de gros bloc de texte indigeste.
   - Rédigé EN CORÉEN structuré et pédagogique avec puces et exemples en français expliqués en coréen.
   - Donne un titre clair à chaque slide (ex: "1. La négation simple", "2. Ne...plus (sens et prononciation)").

2. "exercices" (Sections pratiques) :
   - Extrais les exercices sous forme de sections distinctes.
   - S'il y a des phrases à trous : utilise "____".
   - S'il y a des questions ouvertes de conversation/rédaction : classe-les dans questions_ouvertes.

Structure JSON obligatoire :
{
  "titre": "Titre du chapitre",
  "slides_cours": [
    {
      "numero": 1,
      "titre": "Titre de la fiche",
      "contenu_coreen": "Explications claires en coréen avec exemples bilingues..."
    }
  ],
  "exercices": [
    {
      "titre": "Section 1 : Répondre à la forme négative",
      "consigne": "Répondez aux questions par une phrase complète à la forme négative.",
      "questions": [
        { "q": "Tu vas aller où pendant les vacances ?", "type": "text" }
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
        console.error("Erreur serveur analyse :", err);
        res.status(500).json({ error: err.message });
    }
});

// 2. ENDPOINT CHAT / DIALOGUE AVEC L'IA POUR AJUSTER LE CONTENU
app.post('/api/ajuster-contenu', async (req, res) => {
    try {
        const apiKey = obtenirCleAPI(req);
        if (!apiKey) return res.status(500).json({ error: "Aucune clé API disponible." });

        const modelChoisi = req.headers['x-gemini-model'] || 'gemini-3.8-flash';
        const { contenuActuel, instruction } = req.body;

        if (!contenuActuel || !instruction) {
            return res.status(400).json({ error: "Données de modification manquantes." });
        }

        const prompt = `
Tu es un professeur de FLE pour élèves coréens.
Voici le contenu actuel d'un cours structuré en fiches de grammaire et exercices :
${JSON.stringify(contenuActuel, null, 2)}

INSTRUCTION PRÉCISE DU PROFESSEUR :
"${instruction}"

Consignes :
1. Applique scrupuleusement la demande du professeur.
2. Conserve la même structure JSON (titre, slides_cours, exercices).
3. Assure-toi que les explications de grammaire restent en coréen structuré et clair.

Renvoie UNIQUEMENT le JSON mis à jour :
`;

        const contents = [{ parts: [{ text: prompt }] }];
        const resultatJson = await appelerGeminiAvecSecours(contents, modelChoisi, apiKey);
        res.json(resultatJson);

    } catch (err) {
        console.error("Erreur serveur ajustement :", err);
        res.status(500).json({ error: err.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Serveur French API actif sur le port ${PORT}`));
