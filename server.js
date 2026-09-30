const express = require('express');
const cors = require('cors');
const multer = require('multer');

const app = express();
app.use(cors());
app.use(express.json());

const upload = multer({ limits: { fileSize: 20 * 1024 * 1024 } });

// Fonction pour déterminer la clé à utiliser
function obtenirCleAPI(req) {
    // 1. Clé transmise pour un élève spécifique
    const cleEleve = req.headers['x-custom-api-key'];
    if (cleEleve && cleEleve.trim().startsWith("AIzaSy")) {
        return cleEleve.trim();
    }
    // 2. Sinon : votre clé professeur enregistrée sur Render
    return process.env.GEMINI_API_KEY;
}

// ENDPOINT 1 : ANALYSER LE PDF DE COURS DE FRANÇAIS
app.post('/api/analyser-pdf', upload.single('pdf'), async (req, res) => {
    try {
        const apiKey = obtenirCleAPI(req);
        if (!apiKey) return res.status(500).json({ error: "Aucune clé API Gemini disponible." });
        if (!req.file) return res.status(400).json({ error: "Aucun fichier PDF reçu." });

        const pdfBase64 = req.file.buffer.toString('base64');

        const prompt = `
Tu es un professeur de Français Langue Étrangère (FLE) pour des apprenants coréens.
Analyse attentivement ce document PDF de cours et d'exercices de français.

TÂCHES REQUISES :
1. "grammaire_coreen" :
   - Rédige une synthèse de grammaire point par point, très claire, pédagogique et structurée.
   - Ce résumé DOIT ÊTRE ENTIÈREMENT EN CORÉEN (한국어 핵심 문법 요약).
   - Inclus les règles, les formes (ex: aller + infinitif, terminaisons), les exceptions et la comparaison d'usage avec des exemples en français expliqués en coréen.

2. "exercices_trous" :
   - Extrais toutes les phrases d'exercices à compléter ou conjuguer.
   - Remplace l'espace à remplir par "____" (4 tirets bas).
   - Format : { "q": "S'il pleut demain, on ____ (rester) à la maison." }

3. "questions_ouvertes" :
   - Extrais toutes les questions ouvertes / d'expression libre (ex: "Tu vas faire quoi ce week-end ?").

Renvoie UNIQUEMENT un JSON strict sans texte autour :
{
  "titre": "Titre de la leçon",
  "grammaire_coreen": "Synthèse point par point en coréen...",
  "exercices_trous": [
    { "q": "Phrase avec ____ (verbe)" }
  ],
  "questions_ouvertes": [
    "Question ouverte 1",
    "Question ouverte 2"
  ]
}
`;

        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{
                    parts: [
                        { text: prompt },
                        { inline_data: { mime_type: "application/pdf", data: pdfBase64 } }
                    ]
                }],
                generationConfig: { responseMimeType: "application/json" }
            })
        });

        const data = await response.json();
        if (data.error) return res.status(500).json({ error: data.error.message });

        const resultat = JSON.parse(data.candidates[0].content.parts[0].text);
        res.json(resultat);

    } catch (err) {
        res.status(500).json({ error: "Erreur analyse PDF : " + err.message });
    }
});

// ENDPOINT 2 : CORRECTION / ÉVALUATION D'UNE PHRASE LIBRE
app.post('/api/evaluer-reponse', async (req, res) => {
    try {
        const apiKey = obtenirCleAPI(req);
        if (!apiKey) return res.status(500).json({ error: "Aucune clé API Gemini disponible." });

        const { question, reponseEleve, langue } = req.body;
        if (!reponseEleve) return res.json({ estCorrect: false, explication: "Pas de réponse." });

        const prompt = `
Tu es professeur de français. Évalue la phrase rédigée par un élève coréen.
- Question posée : "${question}"
- Réponse de l'élève : "${reponseEleve}"
- Langue d'explication souhaitée : "${langue || 'fr'}" (fr, ko ou en).

Consignes :
1. Si la phrase est grammaticalement correcte, naturelle et répond à la question : estCorrect = true.
2. Si la phrase a des fautes (conjugaison, temps, accord), indique précisément l'erreur en 1-2 phrases bienveillantes dans la langue demandée.

Renvoie UNIQUEMENT un JSON strict :
{
  "estCorrect": true,
  "explication": ""
}
`;

        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ parts: [{ text: prompt }] }],
                generationConfig: { responseMimeType: "application/json" }
            })
        });

        const data = await response.json();
        const resultat = JSON.parse(data.candidates[0].content.parts[0].text);
        res.json(resultat);

    } catch (err) {
        res.status(500).json({ error: "Erreur évaluation : " + err.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Serveur French API actif sur le port ${PORT}`));
