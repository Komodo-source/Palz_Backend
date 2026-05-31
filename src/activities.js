const ACTIVITY_BASED_LABELS = {
  "Creative": [
    "Atelier poterie",
    "Atelier peinture sur céramique",
    "Atelier aquarelle",
    "Atelier tufting",
    "Atelier création de bijoux",
    "Atelier bougies parfumées",
    "Atelier fleurs séchées",
    "Atelier couture",
    "Atelier broderie",
    "Atelier scrapbooking",
    "Sketching dans Montmartre",
    "Photographie urbaine",
    "Création de moodboards",
    "Atelier calligraphie",
    "Atelier parfum"
  ],
  "Sportive": [
    "Running au Bois de Vincennes",
    "Running au Bois de Boulogne",
    "Escalade en salle",
    "Yoga outdoor",
    "Pilates",
    "Crossfit",
    "Tennis",
    "Padel",
    "Badminton",
    "Vélo le long de la Seine",
    "Roller",
    "Randonnée en Île-de-France",
    "Danse",
    "Natation",
    "Boxe fitness"
  ],
  "Homebody": [
    "Café jeux de société",
    "Après-midi puzzle",
    "Club lecture",
    "Atelier cuisine",
    "Soirée film",
    "Soirée raclette",
    "Atelier pâtisserie",
    "Tea time",
    "Soirée tricot",
    "Café cocooning",
    "Escape game à domicile",
    "Atelier journaling",
    "Vision board party"
  ],
  "Spontanée": [
    "Choisir un métro au hasard",
    "Tester un restaurant inconnu",
    "Explorer un quartier jamais visité",
    "Chiner dans une brocante",
    "Partir à Versailles sur un coup de tête",
    "Pique-nique improvisé",
    "Rooftop de dernière minute",
    "Apéro au coucher du soleil",
    "Croisière improvisée sur la Seine",
    "Week-end surprise"
  ],
  "Ambitieuse": [
    "Coworking day",
    "Networking féminin",
    "Conférence entrepreneuriat",
    "Petit-déjeuner business",
    "Masterclass marketing",
    "Atelier prise de parole",
    "Session objectifs mensuels",
    "Vision board carrière",
    "Meetup startups",
    "Hackathon créatif",
    "Session deep work"
  ],
  "Artiste": [
    "Musée d'Orsay",
    "Musée du Louvre",
    "Centre Pompidou",
    "Galerie d'art contemporaine",
    "Atelier modèle vivant",
    "Concert jazz",
    "Opéra",
    "Théâtre",
    "Improvisation",
    "Atelier écriture",
    "Slam",
    "Exposition photo",
    "Street art tour"
  ],
  "Voyageuse": [
    "Soirée échange linguistique",
    "Restaurant du monde",
    "Préparer un futur voyage ensemble",
    "Explorer Chinatown",
    "Visiter les quartiers multiculturels",
    "Café polyglotte",
    "Projection documentaire voyage",
    "Week-end Normandie",
    "Week-end Lille",
    "Escape game thématique voyage",
    "Carnet de voyage créatif"
  ],
  "Bookworm": [
    "Club lecture",
    "Librairie indépendante",
    "Lecture dans un parc",
    "Café littéraire",
    "Salon du livre",
    "Écriture créative",
    "Lecture silencieuse collective",
    "Discussion autour d'un roman",
    "Échange de livres",
    "Bibliothèque historique"
  ],
  "Foodie": [
    "Brunch",
    "Food market",
    "Dégustation de vins",
    "Atelier pâtisserie",
    "Atelier cuisine italienne",
    "Atelier sushi",
    "Street food tour",
    "Restaurant caché",
    "Food court",
    "Tea room",
    "Atelier chocolat",
    "Dégustation de fromages",
    "Restaurant étoilé"
  ],
  "Geek": [
    "Bar gaming",
    "Escape game",
    "Réalité virtuelle",
    "Quiz pop culture",
    "LAN party",
    "Jeux de société modernes",
    "Convention manga",
    "Convention gaming",
    "Coding café",
    "Hackathon",
    "Soirée anime",
    "Tournoi Mario Kart"
  ],
  "Soirées": [
    "Bar à cocktails",
    "Karaoké",
    "Rooftop",
    "Soirée salsa",
    "Open air",
    "Comedy club",
    "Blind test",
    "DJ set",
    "Concert"
  ],
  "Brunchs": [
    "Brunch parisien",
    "Brunch péniche",
    "Brunch rooftop",
    "Brunch buffet",
    "Brunch healthy",
    "Brunch gourmand"
  ],
  "Voyages": [
    "Organisation de voyage",
    "Week-end surprise",
    "Road trip",
    "City trip",
    "Échange linguistique",
    "Soirée culture étrangère"
  ],
  "Sport": [
    "Yoga",
    "Running",
    "Padel",
    "Escalade",
    "Vélo",
    "Danse",
    "Natation"
  ],
  "Musées/Expos": [
    "Exposition immersive",
    "Musée d'Orsay",
    "Louvre",
    "Atelier artistique",
    "Galerie photo",
    "Street art tour"
  ],
  "Concerts": [
    "Jazz",
    "Pop",
    "Rock",
    "Classique",
    "Open mic",
    "Concert intimiste"
  ],
  "Apéros": [
    "Péniche",
    "Rooftop",
    "Canal Saint-Martin",
    "Berges de Seine",
    "Parc Monceau",
    "Jardin du Luxembourg"
  ],
  "Randos": [
    "Fontainebleau",
    "Vallée de Chevreuse",
    "Parc de Sceaux",
    "Bois de Vincennes",
    "Bois de Boulogne"
  ],
  "Cinéma": [
    "Cinéma indépendant",
    "Cinéma en plein air",
    "Marathon films",
    "Avant-première",
    "Ciné-débat"
  ],
  "Yoga": [
    "Yoga outdoor",
    "Yoga rooftop",
    "Yoga brunch",
    "Yoga + méditation",
    "Yoga dans un parc"
  ],
  "Chien": [
    "Promenade canine",
    "Café dog-friendly",
    "Parc à chiens",
    "Dog walk collectif",
    "Pique-nique avec chiens"
  ],
  "Chat": [
    "Café à chats",
    "Association refuge",
    "Atelier bien-être animal",
    "Adoption solidaire",
    "Soirée films félins"
  ],
  "Voiture": [
    "Road trip",
    "Drive-in",
    "Virée en campagne",
    "Weekend Normandie",
    "Weekend Deauville"
  ],
  "Propriétaire": [
    "Atelier déco",
    "Brocante",
    "DIY maison",
    "Jardinage urbain",
    "Home staging"
  ],
  "Locataire": [
    "Décoration petit budget",
    "Ikea challenge",
    "Brocante vintage",
    "Organisation appartement"
  ],
  "Non-fumeur": [
    "Brunch healthy",
    "Yoga",
    "Running",
    "Randonnée",
    "Jus detox"
  ],
  "Végétarienne": [
    "Restaurant végétarien",
    "Atelier cuisine végétarienne",
    "Brunch veggie",
    "Food market vegan",
    "Atelier nutrition"
  ],
  "Étudiante": [
    "Café révision",
    "Bibliothèque",
    "Afterwork étudiant",
    "Escape game étudiant",
    "Soirée Erasmus"
  ],
  "Freelance": [
    "Coworking café",
    "Networking",
    "Deep work session",
    "Mastermind",
    "Brunch entrepreneures"
  ],
  "Télétravail": [
    "Coworking day",
    "Café coworking",
    "Work & brunch",
    "Digital nomad meetup",
    "Session focus collective"
  ]
}


module.exports = {
  ACTIVITY_BASED_LABELS
};
