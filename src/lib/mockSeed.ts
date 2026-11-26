import type {
  AccountIntent,
  AccountRecord,
  AccountStatus,
  ScrapedAccountInput,
  StorageStateV1,
} from '../types/schema';
import {
  buildProfileUrl,
  createDefaultState,
  DAY_MS,
  HOUR_MS,
  normalizeUsername,
} from './constants';

interface SeedIdentity {
  readonly username: string;
  readonly displayName: string;
  readonly verified: boolean;
}

const AVATAR_PALETTES: ReadonlyArray< readonly [string, string] > = [
  ['#18181B', '#3F3F46'],
  ['#0F172A', '#334155'],
  ['#1E1B4B', '#4338CA'],
  ['#052E16', '#15803D'],
  ['#3B0764', '#7E22CE'],
  ['#451A03', '#B45309'],
  ['#172554', '#1D4ED8'],
  ['#3F1D38', '#9D174D'],
  ['#042F2E', '#0F766E'],
  ['#27272A', '#52525B'],
];

/**
 * Builds an offline-safe crisp SVG data-URI avatar with two-letter initials so zero broken
 * external network requests ever occur in offline or preview environments.
 */
export function buildSvgInitialsAvatar(displayName: string, seedIndex: number): string {
  const cleaned = displayName.replace(/[^a-zA-Z0-9\s]/g, ' ').trim();
  const parts = cleaned.split(/\s+/).filter(Boolean);
  let initials = 'CT';
  if (parts.length >= 2) {
    initials = `${parts[0]?.[0] ?? 'C'}${parts[1]?.[0] ?? 'T'}`.toUpperCase();
  } else if (parts.length === 1 && (parts[0]?.length ?? 0) >= 2) {
    initials = (parts[0] ?? 'CT').slice(0, 2).toUpperCase();
  } else if (parts.length === 1 && parts[0]?.[0]) {
    initials = parts[0][0].toUpperCase();
  }

  const palette = AVATAR_PALETTES[Math.abs(seedIndex) % AVATAR_PALETTES.length] ?? [
    '#18181B',
    '#3F3F46',
  ];
  const [c1, c2] = palette;
  const gradId = `g${Math.abs(seedIndex) % 997}`;

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80" viewBox="0 0 80 80">` +
    `<defs><linearGradient id="${gradId}" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0%" stop-color="${c1}"/><stop offset="100%" stop-color="${c2}"/>` +
    `</linearGradient></defs>` +
    `<rect width="80" height="80" rx="40" fill="url(#${gradId})"/>` +
    `<circle cx="40" cy="40" r="38.5" fill="none" stroke="rgba(255,255,255,0.14)" stroke-width="1.5"/>` +
    `<text x="50%" y="53%" dominant-baseline="middle" text-anchor="middle" ` +
    `fill="#F4F4F5" font-family="-apple-system,BlinkMacSystemFont,Inter,sans-serif" ` +
    `font-size="26" font-weight="600" letter-spacing="0.5">${initials}</text>` +
    `</svg>`;

  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

// Exactly 180 unique realistic accounts across 6 categories (30 per category).
const SEED_IDENTITIES: readonly SeedIdentity[] = [
  // 1..30: Tech, Systems & AI Engineers
  { username: 'karpathy.ai', displayName: 'Andrej Karpathy Notes', verified: true },
  { username: 'dan_abramov.dev', displayName: 'Dan Abramov', verified: true },
  { username: 'rauchg.cloud', displayName: 'Guillermo Rauch', verified: true },
  { username: 'evanyou.vite', displayName: 'Evan You', verified: true },
  { username: 'addyosmani.web', displayName: 'Addy Osmani', verified: true },
  { username: 'cassidoo.codes', displayName: 'Cassidy Williams', verified: true },
  { username: 'kentcdodds.ts', displayName: 'Kent C. Dodds', verified: false },
  { username: 'theo.t3gg', displayName: 'Theo Browne', verified: true },
  { username: 'primeagen.vim', displayName: 'ThePrimeagen', verified: true },
  { username: 'fireship.io', displayName: 'Jeff Delaney', verified: true },
  { username: 'levelsio.indie', displayName: 'Pieter Levels', verified: true },
  { username: 'mitchellh.zig', displayName: 'Mitchell Hashimoto', verified: true },
  { username: 'kelsey.hightower', displayName: 'Kelsey Hightower', verified: true },
  { username: 'juliaevans.wizard', displayName: 'Julia Evans', verified: false },
  { username: 'thorstenball.go', displayName: 'Thorsten Ball', verified: false },
  { username: 'swyx.latent', displayName: 'Shawn Wang', verified: false },
  { username: 'simonwillison.llm', displayName: 'Simon Willison', verified: true },
  { username: 'chip.huyen.ml', displayName: 'Chip Huyen', verified: false },
  { username: 'lexfridman.pod', displayName: 'Lex Fridman', verified: true },
  { username: 'sama.openai', displayName: 'Sam Altman', verified: true },
  { username: 'demishassabis.lab', displayName: 'Demis Hassabis', verified: true },
  { username: 'soumith.pytorch', displayName: 'Soumith Chintala', verified: false },
  { username: 'chris.lattner.mojo', displayName: 'Chris Lattner', verified: false },
  { username: 'rich_harris.svelte', displayName: 'Rich Harris', verified: false },
  { username: 'ryan.carnia.solid', displayName: 'Ryan Carniato', verified: false },
  { username: 'tannerlinsley.ui', displayName: 'Tanner Linsley', verified: false },
  { username: 'shadcn.craft', displayName: 'shadcn Studio', verified: true },
  { username: 'leeerob.next', displayName: 'Lee Robinson', verified: true },
  { username: 'delba.oliveira', displayName: 'Delba de Oliveira', verified: false },
  { username: 'joshwcomeau.css', displayName: 'Josh W. Comeau', verified: false },

  // 31..60: Product, UI/UX & macOS Craft Designers
  { username: 'rauno.freiberg', displayName: 'Rauno Freiberg', verified: true },
  { username: 'paco.coursey', displayName: 'Paco Coursey', verified: false },
  { username: 'emilkowalski.ui', displayName: 'Emil Kowalski', verified: false },
  { username: 'brian_lovin', displayName: 'Brian Lovin', verified: true },
  { username: 'jordan.singer.design', displayName: 'Jordan Singer', verified: false },
  { username: 'karri.saarinen', displayName: 'Karri Saarinen', verified: true },
  { username: 'linear.app', displayName: 'Linear Craft', verified: true },
  { username: 'raycast.mac', displayName: 'Raycast App', verified: true },
  { username: 'arc.internet', displayName: 'The Browser Company', verified: true },
  { username: 'figma.design', displayName: 'Figma', verified: true },
  { username: 'framer.motion', displayName: 'Framer', verified: true },
  { username: 'vercel.design', displayName: 'Vercel Design', verified: true },
  { username: 'steve.schoger', displayName: 'Steve Schoger', verified: false },
  { username: 'adamwathan.tw', displayName: 'Adam Wathan', verified: true },
  { username: 'jessica.hische', displayName: 'Jessica Hische', verified: true },
  { username: 'tobias.vanschneider', displayName: 'Tobias van Schneider', verified: true },
  { username: 'dieter.rams.archive', displayName: 'Dieter Rams Archive', verified: false },
  { username: 'teenage.engineering', displayName: 'teenage engineering', verified: true },
  { username: 'nothing.tech.uk', displayName: 'Nothing Design', verified: true },
  { username: 'minimal.mac.setups', displayName: 'Minimal Mac Setups', verified: false },
  { username: 'panic.playdate', displayName: 'Panic Inc.', verified: true },
  { username: 'ia.writer.app', displayName: 'iA Writer', verified: false },
  { username: 'things.culturedcode', displayName: 'Cultured Code', verified: true },
  { username: 'craft.docs.mac', displayName: 'Craft Docs', verified: true },
  { username: 'amie.calendar', displayName: 'Amie Joyful Productivity', verified: false },
  { username: 'cron.notion.cal', displayName: 'Notion Calendar', verified: true },
  { username: 'mariana.castilho', displayName: 'Mariana Castilho', verified: false },
  { username: 'gavin.nelson.icons', displayName: 'Gavin Nelson', verified: false },
  { username: 'fons.mans.design', displayName: 'Fons Mans', verified: false },
  { username: 'traf.icons', displayName: 'Traf Studio', verified: false },

  // 61..90: Persian Creators, Tech, Music, Cinema & Visual Culture
  { username: 'mhrshadfm.lab', displayName: 'Mehrshad Studio Notes', verified: true },
  { username: 'tehran.street.lens', displayName: 'Tehran Street Lens', verified: false },
  { username: 'shiraz.courtyards', displayName: 'Shiraz Architecture', verified: false },
  { username: 'isfahan.geometry', displayName: 'Isfahan Tile Geometry', verified: false },
  { username: 'kayhan.kalhor.kaman', displayName: 'Kayhan Kalhor', verified: true },
  { username: 'homayoun.shajarian.ir', displayName: 'Homayoun Shajarian', verified: true },
  { username: 'sohrab.pournazeri', displayName: 'Sohrab Pournazeri', verified: true },
  { username: 'asghar.farhadi.cinema', displayName: 'Asghar Farhadi Notes', verified: false },
  { username: 'abbas.kiarostami.frames', displayName: 'Kiarostami Poetics', verified: false },
  { username: 'golshifteh.art', displayName: 'Golshifteh Farahani', verified: true },
  { username: 'taraneh.alidoosti.ir', displayName: 'Taraneh Alidoosti', verified: true },
  { username: 'navid.mohammadzadeh.stage', displayName: 'Navid Theatre Archive', verified: true },
  { username: 'parviz.tanavoli.hec', displayName: 'Parviz Tanavoli', verified: true },
  { username: 'shirin.neshat.studio', displayName: 'Shirin Neshat', verified: true },
  { username: 'reza.abedini.type', displayName: 'Reza Abedini Typography', verified: false },
  { username: 'persian.calligraphy.ink', displayName: 'Nastaaliq Contemporary', verified: false },
  { username: 'alborz.alpine.club', displayName: 'Alborz Summit Trails', verified: false },
  { username: 'damavand.expedition', displayName: 'Mount Damavand Guide', verified: false },
  { username: 'caspian.mist.photo', displayName: 'Mazandaran Fog Diary', verified: false },
  { username: 'yazd.windcatchers', displayName: 'Yazd Desert Adobe', verified: false },
  { username: 'kashan.house.archive', displayName: 'Kashan Historic Homes', verified: false },
  { username: 'roudaki.philharmonic', displayName: 'Tehran Symphony Notes', verified: false },
  { username: 'persian.specialty.roast', displayName: 'Tehran Third Wave Coffee', verified: false },
  { username: 'arman.darvish.design', displayName: 'Arman Darvish', verified: false },
  { username: 'nikoo.bahrami.ux', displayName: 'Nikoo Bahrami', verified: false },
  { username: 'kian.rostami.code', displayName: 'Kian Rostami', verified: false },
  { username: 'parisa.tabrizi.sec', displayName: 'Parisa Tabrizi', verified: true },
  { username: 'dara.khosrowshahi.lead', displayName: 'Dara Khosrowshahi', verified: true },
  { username: 'pejman.nozad.vc', displayName: 'Pejman Nozad', verified: true },
  { username: 'hadi.partovi.code', displayName: 'Hadi Partovi', verified: true },

  // 91..120: Street, Editorial & Landscape Photographers
  { username: 'chrisburkard.wild', displayName: 'Chris Burkard', verified: true },
  { username: 'petermckinnon.raw', displayName: 'Peter McKinnon', verified: true },
  { username: 'brandonwoelfel.glow', displayName: 'Brandon Woelfel', verified: true },
  { username: 'alan.schaller.bw', displayName: 'Alan Schaller', verified: true },
  { username: 'fan.ho.hongkong', displayName: 'Fan Ho Estate', verified: false },
  { username: 'saul.leiter.color', displayName: 'Saul Leiter Foundation', verified: false },
  { username: 'magnum.photos', displayName: 'Magnum Photos', verified: true },
  { username: 'leica.camera.wetzlar', displayName: 'Leica Camera', verified: true },
  { username: 'hasselblad.medium', displayName: 'Hasselblad', verified: true },
  { username: 'fujifilm.xseries', displayName: 'Fujifilm X Series', verified: true },
  { username: 'kodak.portra.400', displayName: 'Analog Portra Club', verified: false },
  { username: 'cinestill.800t', displayName: 'CineStill Night Frames', verified: false },
  { username: 'shortstache.frames', displayName: 'Garrett King', verified: true },
  { username: 'benjaminhardman.ice', displayName: 'Benjamin Hardman', verified: true },
  { username: 'alex.strohl.nord', displayName: 'Alex Strohl', verified: true },
  { username: 'hannes.becker.alps', displayName: 'Hannes Becker', verified: true },
  { username: 'joe.greer.film', displayName: 'Joe Greer', verified: true },
  { username: 'willem.verbeeck', displayName: 'Willem Verbeeck', verified: false },
  { username: 'grainydays.analog', displayName: 'Jason Kummerfeldt', verified: false },
  { username: 'trevor.wisecup', displayName: 'Trevor Wisecup', verified: false },
  { username: 'greg.williams.photo', displayName: 'Greg Williams', verified: true },
  { username: 'annie.leibovitz.lens', displayName: 'Annie Leibovitz', verified: true },
  { username: 'steve.mccurry.world', displayName: 'Steve McCurry', verified: true },
  { username: 'jimmy.chin.summit', displayName: 'Jimmy Chin', verified: true },
  { username: 'paul.nicklen.polar', displayName: 'Paul Nicklen', verified: true },
  { username: 'cristina.mittermeier', displayName: 'Cristina Mittermeier', verified: true },
  { username: 'liam.wong.tokyo', displayName: 'Liam Wong', verified: true },
  { username: 'masashi.wakui.neon', displayName: 'Masashi Wakui', verified: false },
  { username: 'rk.tokyo.street', displayName: 'Ryosuke Kosuge', verified: true },
  { username: 'erina.kamono.film', displayName: 'Erina Kamono', verified: false },

  // 121..150: Generative Art, Architecture & 3D Studios
  { username: 'refikanadol.studio', displayName: 'Refik Anadol', verified: true },
  { username: 'zach.lieberman.code', displayName: 'Zach Lieberman', verified: true },
  { username: 'mattdesl.canvas', displayName: 'Matt DesLauriers', verified: false },
  { username: 'tyler.xhobbs', displayName: 'Tyler Hobbs', verified: true },
  { username: 'inconvergent.plot', displayName: 'Anders Hoff', verified: false },
  { username: 'manoloide.gen', displayName: 'Manolo Gamboa Naon', verified: false },
  { username: 'beeple.everyday.3d', displayName: 'Mike Winkelmann', verified: true },
  { username: 'ash.thorp.design', displayName: 'Ash Thorp', verified: true },
  { username: 'gmunk.optics', displayName: 'Bradley G Munkowitz', verified: true },
  { username: 'sixnfive.studio', displayName: 'Six N. Five', verified: true },
  { username: 'andres.reisinger', displayName: 'Andres Reisinger', verified: true },
  { username: 'archdaily.global', displayName: 'ArchDaily', verified: true },
  { username: 'dezeen.mag', displayName: 'Dezeen Architecture', verified: true },
  { username: 'designboom.milano', displayName: 'designboom', verified: true },
  { username: 'wallpaper.magazine', displayName: 'Wallpaper* Magazine', verified: true },
  { username: 'bjarke.ingels.big', displayName: 'Bjarke Ingels', verified: true },
  { username: 'tadao.ando.concrete', displayName: 'Tadao Ando Notes', verified: false },
  { username: 'kengo.kuma.timber', displayName: 'Kengo Kuma Associates', verified: true },
  { username: 'zaha.hadid.arch', displayName: 'Zaha Hadid Architects', verified: true },
  { username: 'fosterandpartners', displayName: 'Foster + Partners', verified: true },
  { username: 'snohetta.oslo', displayName: 'Snohetta Studio', verified: true },
  { username: 'herzog.demeuron', displayName: 'Herzog & de Meuron', verified: false },
  { username: 'peter.zumthor.therme', displayName: 'Peter Zumthor Studies', verified: false },
  { username: 'john.pawson.minimal', displayName: 'John Pawson', verified: true },
  { username: 'vincent.vanduysen', displayName: 'Vincent Van Duysen', verified: true },
  { username: 'norm.architects.cph', displayName: 'Norm Architects', verified: true },
  { username: 'kinfolk.editorial', displayName: 'Kinfolk', verified: true },
  { username: 'cereal.mag.london', displayName: 'Cereal Magazine', verified: true },
  { username: 'monocle.zurich', displayName: 'Monocle', verified: true },
  { username: 'apartamento.bcn', displayName: 'Apartamento Magazine', verified: true },

  // 151..180: Science, Music, Culinary, Books & Noise/Drop Accounts
  { username: 'nasa.webb.telescope', displayName: 'NASA Webb Telescope', verified: true },
  { username: 'cern.geneva.lab', displayName: 'CERN Physics', verified: true },
  { username: 'esa.earth.orbit', displayName: 'European Space Agency', verified: true },
  { username: 'mit.medialab', displayName: 'MIT Media Lab', verified: true },
  { username: 'quanta.magazine', displayName: 'Quanta Magazine', verified: true },
  { username: 'kurzgesagt.birds', displayName: 'Kurzgesagt In a Nutshell', verified: true },
  { username: 'veritasium.science', displayName: 'Derek Muller', verified: true },
  { username: '3blue1brown.math', displayName: 'Grant Sanderson', verified: true },
  { username: 'mkbhd.studio', displayName: 'Marques Brownlee', verified: true },
  { username: 'dave2d.tech', displayName: 'Dave Lee', verified: true },
  { username: 'optimum.sffpc', displayName: 'Optimum Tech', verified: false },
  { username: 'james.hoffmann.coffee', displayName: 'James Hoffmann', verified: true },
  { username: 'noma.copenhagen', displayName: 'Noma Projects', verified: true },
  { username: 'ottolenghi.kitchen', displayName: 'Yotam Ottolenghi', verified: true },
  { username: 'samin.nosrat.salt', displayName: 'Samin Nosrat', verified: true },
  { username: 'nils.frahm.piano', displayName: 'Nils Frahm', verified: true },
  { username: 'olafur.arnalds', displayName: 'Olafur Arnalds', verified: true },
  { username: 'max.richter.music', displayName: 'Max Richter', verified: true },
  { username: 'boilerroom.tv', displayName: 'Boiler Room', verified: true },
  { username: 'kexp.seattle', displayName: 'KEXP Radio', verified: true },
  { username: 'a24.films.nyc', displayName: 'A24', verified: true },
  { username: 'criterion.closet', displayName: 'Criterion Collection', verified: true },
  { username: 'penguin.classics', displayName: 'Penguin Books', verified: true },
  { username: 'newyorker.cartoons', displayName: 'The New Yorker', verified: true },
  { username: 'flash.deals.archive99', displayName: 'Daily Promo Archive', verified: false },
  { username: 'old.meme.vault.2019', displayName: 'Throwback Clips 2019', verified: false },
  { username: 'inactive.shop.drops', displayName: 'Seasonal Merch Drops', verified: false },
  { username: 'random.giveaway.hub', displayName: 'Contest Repost Hub', verified: false },
  { username: 'dead.podcast.clips', displayName: 'Archived Ep Clips', verified: false },
  { username: 'dormant.crypto.news', displayName: '2021 Token Digest', verified: false },
];

const EXTRA_DISCOVERY_POOL: readonly SeedIdentity[] = [
  { username: 'deno.land.runtime', displayName: 'Deno Runtime', verified: true },
  { username: 'bun.sh.oven', displayName: 'Bun JavaScript', verified: true },
  { username: 'zed.industries', displayName: 'Zed Code Editor', verified: true },
  { username: 'obsidian.md.vault', displayName: 'Obsidian Knowledge', verified: true },
  { username: 'readwise.reader', displayName: 'Readwise', verified: false },
  { username: 'cronometer.health', displayName: 'Studio Balance', verified: false },
  { username: 'shiraz.poetics.club', displayName: 'Hafez & Saadi Archive', verified: false },
  { username: 'tehran.contemporary.art', displayName: 'TMoCA Collection', verified: false },
  { username: 'valiasr.autumn.walk', displayName: 'Valiasr Plane Trees', verified: false },
  { username: 'darband.mountain.tea', displayName: 'Darband Evening Notes', verified: false },
  { username: 'kyoto.moss.gardens', displayName: 'Kyoto Zen Architecture', verified: false },
  { username: 'zurich.type.foundry', displayName: 'Swiss Grid Foundry', verified: false },
  { username: 'copenhagen.cycling.log', displayName: 'Nordic Urbanism', verified: false },
  { username: 'analog.darkroom.club', displayName: 'Silver Gelatin Prints', verified: false },
  { username: 'modular.synth.patch', displayName: 'Eurorack Ambient Lab', verified: false },
  { username: 'bauhaus.dessau.1919', displayName: 'Bauhaus Archive', verified: true },
  { username: 'vitra.design.museum', displayName: 'Vitra Design Museum', verified: true },
  { username: 'taschen.books', displayName: 'TASCHEN', verified: true },
];

function resolveBucketForSlot(slot: number): { status: AccountStatus; intent: AccountIntent } {
  // Exact 180-account distribution:
  //   0..53  (54) -> following (migrate)
  //  54..89  (36) -> following (drop)         [Total following = 90]
  //  90..99  (10) -> queued_unfollow (drop)
  // 100..107  (8) -> queued_unfollow (migrate) [Total queued_unfollow = 18]
  // 108..143 (36) -> unfollowed_migrate (migrate)
  // 144..153 (10) -> unfollowed_dropped (drop)
  // 154..171 (18) -> migrated_following (migrate)
  // 172..179  (8) -> migrated_requested (migrate)
  if (slot < 54) {
    return { status: 'following', intent: 'migrate' };
  }
  if (slot < 90) {
    return { status: 'following', intent: 'drop' };
  }
  if (slot < 100) {
    return { status: 'queued_unfollow', intent: 'drop' };
  }
  if (slot < 108) {
    return { status: 'queued_unfollow', intent: 'migrate' };
  }
  if (slot < 144) {
    return { status: 'unfollowed_migrate', intent: 'migrate' };
  }
  if (slot < 154) {
    return { status: 'unfollowed_dropped', intent: 'drop' };
  }
  if (slot < 172) {
    return { status: 'migrated_following', intent: 'migrate' };
  }
  return { status: 'migrated_requested', intent: 'migrate' };
}

/**
 * Deterministically builds the 180-account seeded StorageStateV1 for browser dev/preview mode.
 */
export function createMockSeedState(now = Date.now()): StorageStateV1 {
  const state = createDefaultState();
  const accounts: Record<string, AccountRecord> = {};

  // gcd(7, 180) === 1 permutes categories evenly across every status tab!
  for (let slot = 0; slot < 180; slot += 1) {
    const sourceIndex = (slot * 7) % SEED_IDENTITIES.length;
    const identity = SEED_IDENTITIES[sourceIndex] ?? {
      username: `creator.node.${slot + 1}`,
      displayName: `Creator Node ${slot + 1}`,
      verified: false,
    };

    let username = normalizeUsername(identity.username);
    if (accounts[username]) {
      username = `${username}.${slot + 1}`;
    }

    const { status, intent } = resolveBucketForSlot(slot);
    const extractedAt = now - (180 - slot) * 42_000 - 3 * DAY_MS;

    let unfollowedAt: number | undefined;
    let migratedAt: number | undefined;

    if (
      status === 'unfollowed_migrate' ||
      status === 'unfollowed_dropped' ||
      status === 'migrated_following' ||
      status === 'migrated_requested'
    ) {
      unfollowedAt = now - ((slot % 32) + 1) * 1_900_000;
    }

    if (status === 'migrated_following' || status === 'migrated_requested') {
      migratedAt = now - ((slot % 22) + 1) * 1_350_000;
      if (unfollowedAt !== undefined && migratedAt < unfollowedAt) {
        unfollowedAt = migratedAt - 600_000;
      }
    }

    accounts[username] = {
      username,
      displayName: identity.displayName,
      avatarUrl: buildSvgInitialsAvatar(identity.displayName, sourceIndex),
      profileUrl: buildProfileUrl(username),
      isVerified: identity.verified,
      status,
      intent,
      extractedAt,
      ...(unfollowedAt !== undefined ? { unfollowedAt } : {}),
      ...(migratedAt !== undefined ? { migratedAt } : {}),
    };
  }

  // 19 unfollow timestamps in last 24h (5 in last 60m, 14 in 1h..23h)
  const unfollowMinutesAgo = [
    6, 14, 23, 35, 48, // 5 in last hour
    78, 112, 165, 220, 290, 360, 440, 530, 640, 760, 890, 1020, 1160, 1310, // 14 earlier in 24h
  ];

  // 11 follow timestamps in last 24h (3 in last 60m, 8 in 1h..23h)
  const followMinutesAgo = [
    9, 27, 44, // 3 in last hour
    95, 175, 280, 410, 560, 740, 960, 1210, // 8 earlier in 24h
  ];

  state.accounts = accounts;
  state.safety.unfollowTimestamps = unfollowMinutesAgo
    .map((mins) => now - mins * 60_000)
    .filter((ts) => ts > now - DAY_MS)
    .sort((a, b) => a - b);

  state.safety.followTimestamps = followMinutesAgo
    .map((mins) => now - mins * 60_000)
    .filter((ts) => ts > now - DAY_MS && ts <= now + HOUR_MS)
    .sort((a, b) => a - b);

  state.scraper = {
    scrollState: 'idle',
    extractedCount: Object.keys(accounts).length,
    sessionNewCount: 0,
    stepCount: 0,
    retryCount: 0,
    statusText: '180 accounts loaded in preview workspace.',
  };

  return state;
}

/**
 * Generates deterministic mock scraped rows during dev-mode live scraper simulation.
 */
export function generateMockScrapedBatch(
  existingUsernames: ReadonlySet<string>,
  count: number,
  stepSeed: number,
): ScrapedAccountInput[] {
  const results: ScrapedAccountInput[] = [];

  for (const candidate of EXTRA_DISCOVERY_POOL) {
    if (results.length >= count) {
      break;
    }
    const clean = normalizeUsername(candidate.username);
    if (!existingUsernames.has(clean)) {
      results.push({
        username: clean,
        displayName: candidate.displayName,
        avatarUrl: buildSvgInitialsAvatar(candidate.displayName, stepSeed + results.length + 200),
        isVerified: candidate.verified,
      });
    }
  }

  let fallbackIndex = stepSeed * 3 + 1;
  while (results.length < count) {
    const clean = `discovered.creator.${fallbackIndex}`;
    if (!existingUsernames.has(clean) && !results.some((r) => r.username === clean)) {
      const displayName = `Discovered Creator ${fallbackIndex}`;
      results.push({
        username: clean,
        displayName,
        avatarUrl: buildSvgInitialsAvatar(displayName, fallbackIndex + 300),
        isVerified: fallbackIndex % 4 === 0,
      });
    }
    fallbackIndex += 1;
  }

  return results;
}
