// Copyright 2024 Free Chess Club.
// Use of this source code is governed by a GPL-style
// license that can be found in the LICENSE file.

import { awaiting, storage } from './storage';
import { createNotification, removeNotification } from './dialogs';
import { convertToServerDateTime, convertToLocalDateTime, getDiffDays } from './utils';

export class Tournaments {
  private tdMessage = ''; // Stores messages from td (tournament bot)
  private tdVariables: any = {}; // Stores user's td variables
  private session = null;
  private alerts: any = {};
  private kothShowNotifications = false;
  private kothReceiveInfo = false;
  private kothFollowKing = null;
  private tournamentsShowNotifications = false;
  private tournamentsReceiveInfo = false;
  private tournamentsReceiveUpdates = false;
  private notifyList = {};
  private pendingTournaments = [];

  constructor() {
    $(document).on('shown.bs.tab', 'button[data-bs-target="#pills-tournaments"]', (e) => {
      $('button[data-bs-target="#pills-tournaments"]').removeClass('tournaments-unviewed');
      this.initTournamentsPane(this.session);
    });

    $(document).on('hidden.bs.tab', 'button[data-bs-target="#pills-tournaments"]', () => {
      this.leaveTournamentsPane();
    });

    $(document).on('shown.bs.tab', 'button[data-bs-target="#pills-play"]', () => {
      if($('#pills-tournaments').hasClass('active')) {
        $('button[data-bs-target="#pills-tournaments"]').removeClass('tournaments-unviewed');
        this.initTournamentsPane(this.session);
      }
    });

    $(document).on('hidden.bs.tab', 'button[data-bs-target="#pills-play"]', () => {
      this.leaveTournamentsPane();
    });

    this.kothShowNotifications = (storage.get('koth-show-notifications') === 'true');
    this.kothReceiveInfo = (storage.get('koth-receive-info') === 'true');
    this.tournamentsShowNotifications = (storage.get('tournaments-show-notifications') === 'true');
    this.tournamentsReceiveInfo = (storage.get('tournaments-receive-info') === 'true');
    this.tournamentsReceiveUpdates = (storage.get('tournaments-receive-updates') === 'true');
    this.notifyList = JSON.parse(storage.get('tournaments-notify-list')) || {};
  }

  public connected(session: any) {
    this.session = session;
    
    if(this.kothReceiveInfo != null) {
      awaiting.set('td-set');
      this.session.send(`td set KOTHInfo ${this.kothReceiveInfo ? 1 : 0}`);
    }

    if(this.tournamentsReceiveInfo != null) {
      awaiting.set('td-set'); 
      this.session.send(`td set TourneyInfo ${this.tournamentsReceiveInfo ? 1 : 0}`);
    }
    if(this.tournamentsReceiveUpdates != null) {
      awaiting.set('td-set'); 
      this.session.send(`td set TourneyUpdates ${this.tournamentsReceiveUpdates ? 1 : 0}`);
    }
    
    if($('#pills-tournaments').hasClass('active'))
      this.initTournamentsPane(session);
  }

  public initTournamentsPane(session: any) {
    if(!session || !session.isConnected())
      return;
    
    this.tdVariables = {};

    $('#tournaments-pane-status').hide();
    awaiting.set('td-set');
    this.session.send('td set height 999');
    awaiting.set('td-variables');
    this.session.send('td variables');

    this.addTournament({
      title: 'The Nightly 5 0 at 22:00',
      type: '5 0 r SS\\5',
      recurring: 'daily',
    });

    awaiting.set('td-set');
    this.session.send('td set tourneyinfo 1');

    awaiting.set('td-listtourneys');
    this.session.send('td listtourneys');

    awaiting.set('td-set');
    this.session.send('td set kothinfo 1');

    awaiting.set('td-listkoths');
    this.session.send('td listkoths');
  
    awaiting.set('td-set');
    this.session.send('td set height 24');
  }

  public leaveTournamentsPane() {
    if(this.session && this.session.isConnected()) {
      awaiting.set('td-set');
      this.session.send(`td set kothinfo ${this.kothReceiveInfo ? 'On' : 'Off'}`);
      awaiting.set('td-set');
      this.session.send(`td set tourneyinfo ${this.tournamentsReceiveInfo ? 'On' : 'Off'}`);
      awaiting.set('td-set');
      this.session.send(`td set tourneyupdates ${this.tournamentsReceiveUpdates ? 'On' : 'Off'}`);
    }
  }

  public handleMessage(msg: string): boolean {
    let match, pattern;
  
    if(!msg.startsWith(':') && !awaiting.has('koth-get-game'))
      return false;

    match = msg.match(/^:Your (\S+) variable has been set to (\S+)./m);
    if(match) {
      this.tdVariables[match[1]] = match[2]; 
      if(awaiting.resolve('td-set'))
        return true;
    }  

    match = msg.match(/^:Your KOTHInfo variable has been set to (On|Off)./m);
    if(match) {
      this.kothReceiveInfo = (match[1] === 'On' ? true : false);
      if(!this.kothReceiveInfo) 
        this.kothShowNotifications = false;
      this.updateGroup('koth');
      return false;
    }

    match = msg.match(/^:Your Female variable has been set to (Yes|No)./m);
    if(match) {
      this.updateGroup('koth');
      return false;
    }

    if(/^:mamer KOTH INFO: The throne of KOTH #\d+, a [^,]+, is still empty./m.test(msg))
      return true;

    pattern = ':Variable settings of';
    if((msg.startsWith(pattern) || this.tdMessage.startsWith(pattern)) && awaiting.has('td-variables')) {    
      this.tdMessage += msg + '\n';
      if(/^:Language:/m.test(msg)) {
        awaiting.resolve('td-variables');
        this.parseTDVariables(this.tdMessage);
        this.kothReceiveInfo = (this.tdVariables.KOTHInfo === 'On' ? true : false); 
        this.updateGroup('koth');
        this.tournamentsReceiveInfo = (this.tdVariables.TourneyInfo === 'On' ? true : false); 
        this.tournamentsReceiveUpdates = (this.tdVariables.TourneyUpdates === 'On' ? true : false); 
        this.updateGroup('tournament');
        this.tdMessage = '';
      }
      return true;
    }

    match = msg.match(/^:mamer KOTH INFO: ((\S+) is the new (king|queen) of KOTH #(\d+), a [^!]+!)/m);
    if(!match)
      match = msg.match(/^:((\S+), the current (king|queen) of KOTH #(\d+), a [^,]+, defended the title against \S+ and is still the (?:king|queen)!)/m);
    if(match) {
      const king = match[2];
      const id = +match[4];
      removeNotification($(`[data-koth-id="${id}"`));
      if(this.kothShowNotifications && king !== this.session.getUser()) {
        const kingQueenStr = match[3].charAt(0).toUpperCase() + match[3].slice(1);
        const nElement = createNotification({
          type: `Long live the ${kingQueenStr}!`, 
          msg: match[1], 
          btnSuccess: [`td matchking ${id}`, 'Challenge'],
          btnFailure: [`td followking ${id}`, `Follow ${kingQueenStr}`],
          useSessionSend: true,
          icons: false
        });
        nElement.attr('data-koth-id', id);
      }
      this.updateKoTH(id, {
        king,
        kingStats: undefined,
      }, true);
      awaiting.set('td-kingstats');
      this.session.send(`td kingstats ${id}`);
      return false;
    }

    match = msg.match(/^:mamer KOTH INFO: \S+ (?:abdicated|left) as (?:king|queen) of KOTH #(\d+)!/m);
    if(match) {
      const id = +match[1];
      this.updateKoTH(id, {
        king: '-',
        kingStats: undefined,
      }, false);
      return false;
    }

    match = msg.match(/^:mamer KOTH INFO: (\S+), the (?:king|queen) of KOTH #(\d+), has started a game with (\S+)./m);
    if(match) {
      const king = match[1];
      const id = +match[2];
      const opponent = match[3];
      this.updateKoTH(id, {
        king: match[1],
        opponent: match[3],
      });
      return false;
    }

    if(awaiting.has('get-koth-game')) {
      match = msg.match(/(?:^|\n)\s*(\d+)\s+(?:\(Exam\.\s+)?[0-9\+\-]+\s(\w+)\s+[0-9\+\-]+\s(\w+)\s*(?:\)\s+)?\[[\w\s]+\]\s+[\d:]+\s*\-\s*[\d:]+\s\(\s*\d+\-\s*\d+\)\s+[BW]:\s+\d+\s*\d+ games? displayed/);
      if(match && awaiting.resolve('get-koth-game')) {
        const id = +match[1];
        const player1 = match[2];
        const player2 = match[3];
        const koths = $('[data-tournament-type="koth"]');
        koths.each((index, element) => {
          const kothData = $(element).data('tournament-data');
          if((kothData.king === player1 || kothData.king === player2)
            && (kothData.opponent || kothData.game !== '-')) {
            const opponent = kothData.king === player1 ? player2 : player1;
            this.updateKoTH(kothData.id, {
              opponent,
              game: id,
            });
            return false;
          } 
        });
        return true;
      }
    }

    match = msg.match(/^:mamer KOTH INFO: \{KOTH #(\d+) \(\w+ vs. \w+\)/m);
    if(match) {
      const id = +match[1];
      this.updateKoTH(+match[1], {
        game: '-',
        opponent: undefined,
      });
      return false;
    }

    match = msg.match(/^:You (?:will now be|are already) following KOTH #(\d+)./m);
    if(match) {
      const followID = +match[1];
      this.kothFollowKing = followID;
      const koths = $('[data-tournament-type="koth"]');
      koths.each((index, element) => {
        const id = +$(element).attr('data-tournament-id');
        this.updateKoTH(id, {
          following: followID === id,
        });        
      });
      return false;
    }

    match = msg.match(/^:You will not follow any KOTH./m);
    if(match) {     
      this.kothFollowKing = null;
      this.updateAllKoTHs({
        following: false,        
      });
      return false;
    }

    pattern = ':mamer\'s KOTH list:';
    if((msg.startsWith(pattern) || this.tdMessage.startsWith(pattern)) && awaiting.has('td-listkoths')) {
      this.tdMessage += msg + '\n';
      if(/:Total: \d+ KOTHs/m.test(msg)) {
        awaiting.resolve('td-listkoths');
        const koths = this.parseTDListKoTHs(msg);
        koths.forEach(koth => { 
          this.addKoTH(koth);
          if(koth.king !== '-') {
            awaiting.set('td-kingstats');
            this.session.send(`td kingstats ${koth.id}`);
          }
          if(koth.game !== '-') {
            awaiting.set('get-koth-game');
            this.session.send(`games ${koth.game}`);
          }
        });
        this.tdMessage = '';
      }
      return true;
    }

    match = msg.match(/^:\S+, the king of KOTH #(\d+), has a record of (\d+) (?:victories|victory), (\d+) (?:loss|losses) and (\d+) draws?./m);
    if(match && awaiting.resolve('td-kingstats')) {
      this.updateKoTH(+match[1], {
        kingStats: {
          wins: match[2], 
          losses: match[3], 
          draws: match[4]
        }
      });
      return true;
    }

    match = msg.match(/^:You have a record of (\d+) (?:victories|victory), (\d+) (?:loss|losses) and (\d+) draws?./);
    if(match && awaiting.resolve('td-kingstats')) {
      const koths = $('[data-tournament-type="koth"]');
      koths.each((index, element) => {
        const kothData = $(element).data('tournament-data');
        if(kothData.king === this.session.getUser() && !kothData.kingStats) {
          this.updateKoTH(kothData.id, {
            kingStats: {
              wins: match[1], 
              losses: match[2], 
              draws: match[3]
            }
          });
          return false;
        }
      });
      return true;
    }
    match = msg.match(/^:Unable to comply. KOTH #\d+ does not have a king./);
    if(match && awaiting.resolve('td-kingstats')) {
      return true;
    }
  
    match = msg.match(/^:Unable to comply. (Access to command ClaimThrone denied.)/);
    if(match) {
      if(this.session.isRegistered())
        $('#tournaments-pane-status').text(match[1]);
      else
        $('#tournaments-pane-status').html('<span>You must be registered to participate in King of the Hill. <a href="https://www.freechess.org/cgi-bin/Register/FICS_register.cgi?Language=English" target="_blank">Register now</a>.</span>');  
      $('#tournaments-pane-status').show();
      return false;
    }

    match = msg.match(/^:Your TourneyInfo variable has been set to (On|Off)./m);
    if(match) {
      this.tournamentsReceiveInfo = (match[1] === 'On' ? true : false);
      this.notifyList = {};
      if(!this.tournamentsReceiveInfo) 
        this.tournamentsShowNotifications = false;
      this.updateGroup('tournament');
      return false;
    }

    match = msg.match(/^:Your TourneyUpdates variable has been set to (On|Off)./m);
    if(match) {
      this.tournamentsReceiveUpdates = (match[1] === 'On' ? true : false);
      return false;
    }

    match = msg.match(/^:You are now observing tourney #(\d+)./m);
    if(match && awaiting.resolve('td-observetourney'))
      return true;
    match = msg.match(/^:You are no longer observing tourney #(\d+)./m);
    if(match && awaiting.has('td-observetourney')) {
      this.session.send(`td observetourney ${match[1]}`);
      return true;
    }

    match = msg.match(/^:mamer TOURNEY INFO: \*\*\* (.*?) \*\*\*\n:Tourney #(\d+), a [^,]+, has been opened!/m);
    if(match) {
      const title = match[1];
      const id = +match[2];
      this.addTournament({
        id,
        title,
        running: true,
        joinable: true,
        joined: false,
        status: 'open',
        numPlayers: 0,
        date: null,
      });

      if($('#pills-tournaments').hasClass('active')) {
        awaiting.set('td-observetourney');
        this.session.send(`td observetourney ${id}`);
      }
      return false;
    }

    match = msg.match(/^:mamer TOURNEY #(\d+) UPDATE: Tourney #2 has started!/m);
    if(match) {
      const id = +match[1];
      // get grid, joinable, observe, games?
      return false;
    }

    match = msg.match(/^:You have joined tourney #(\d+)./m);
    if(match) {
      const id = +match[1];
      this.updateTournament(id, {
        joined: true,
      });
      this.updateAllTournaments({}); // Stop user joining other running tournaments
      return false;
    }

    
    match = msg.match(/^:You withdrew from tourney #(\d+)./m);
    if(match) {
      const id = +match[1];
      this.updateTournament(id, {
        joined: false,
      });
      this.updateAllTournaments({});
      return false;
    }

    match = msg.match(/:mamer TOURNEY #(\d+) UPDATE: \S+ has joined tourney #\d+ \(seed: \d+, score: \d+\); (\d+) players? now!/m);
    if(match) {
      const id = +match[1];
      const numPlayers = +match[2];
      this.updateTournament(id, {
        numPlayers: numPlayers
      });
      return false;
    }

    match = msg.match(/:mamer TOURNEY #(\d+) UPDATE: \S+ withdrew from tourney #\d+; (\d+) players? now./m);
    if(match) {
      const id = +match[1];
      const numPlayers = +match[2];
      this.updateTournament(id, {
        numPlayers: numPlayers
      });    
      return false;
    }
    
    match = msg.match(/^:mamer TOURNEY #(\d+) UPDATE: The tourney has ended./m);
    if(match) {
      const id = +match[1];
      this.updateTournament(id, {
        running: false,
      });
      return false;
    }

    match = msg.match(/^:mamer TOURNEY #(\d+) UPDATE: Tourney #\d+ has been closed!/m);
    if(match) {
      const id = +match[1];
      // tourney still open for late joiners?
      return false;
    }

    match = msg.match(/^:mamer TOURNEY INFO: Tourney #(\d+) has been aborted!/m);
    if(match) {
      const id = +match[1];
      // tourney no longer running
      return false;
    }

    pattern = ':mamer\'s tourney list:';
    if((msg.startsWith(pattern) || this.tdMessage.startsWith(pattern)) && awaiting.has('td-listtourneys')) {
      this.tdMessage += msg + '\n';
      if(/^:Listed: \d+ tourneys/m.test(msg)) {
        awaiting.resolve('td-listtourneys');
        const tourneys = this.parseTDListTourneys(this.tdMessage);
        tourneys.sort((a, b) => {
          // First: sort by `running` (true before false)
          if(a.running !== b.running) 
            return a.running ? -1 : 1;
          
          // Then: sort by date (latest first)
          const dateA = new Date(a.date.year, a.date.month - 1, a.date.day);
          const dateB = new Date(b.date.year, b.date.month - 1, b.date.day);
          return dateB.getTime() - dateA.getTime(); 
        });
        tourneys.forEach(tourney => { 
          this.pendingTournaments.push(tourney);
          if(tourney.running && tourney.status !== 'started') {
            awaiting.set('td-players');
            this.session.send(`td players ${tourney.id}`);
          }
          else {
            awaiting.set('td-standardgrid');
            this.session.send(`td standardgrid ${tourney.id}`);
          }

          if(tourney.running) {
            awaiting.set('td-observetourney');
            this.session.send(`td observetourney ${tourney.id}`);
          }
        });
        this.tdMessage = '';
      }
      return true;
    }

    pattern = /^:Tourney #(\d+)'s player list:/m;
    if((pattern.test(msg) || pattern.test(this.tdMessage)) && awaiting.has('td-players')) {
      this.tdMessage += msg + '\n';
      const matchLastLine = msg.match(/:Listed:\s+(\d+) players?./m);
      if(matchLastLine) {
        const numPlayers = +matchLastLine[1];
        awaiting.resolve('td-players');
        const matchIDLine = this.tdMessage.match(pattern);
        const id = +matchIDLine[1];
        const title = this.tdMessage.split(/[\r\n]+/)[0].trim().slice(1);
        for(let i = this.pendingTournaments.length - 1; i >= 0; i--) {
          const pt = this.pendingTournaments[i];
          if(pt.id === id) {
            pt.title = title;
            pt.numPlayers = numPlayers;
            this.addTournament(pt);
            this.pendingTournaments.splice(i, 1);
          }
        }
        this.tdMessage = '';
      }
      return true;
    }

    pattern = /^:Tourney #(\d+)'s standard grid:/m;
    if((pattern.test(msg) || pattern.test(this.tdMessage)) && awaiting.has('td-standardgrid')) {
      this.tdMessage += msg + '\n';
      const matchLastLine = msg.match(/^:\+-+\+(?![\r\n])/m);
      if(matchLastLine) {
        awaiting.resolve('td-players');
        const grid = this.parseTDStandardGrid(this.tdMessage);
        const numPlayers = grid.length;
        const matchIDLine = this.tdMessage.match(pattern);
        const id = +matchIDLine[1];
        const title = this.tdMessage.split(/[\r\n]+/)[0].trim().slice(1);
        for(let i = this.pendingTournaments.length - 1; i >= 0; i--) {
          const pt = this.pendingTournaments[i];
          if(pt.id === id) {
            pt.title = title;
            pt.numPlayers = numPlayers;
            if(!pt.running) {
              const highestScore = Math.max(...grid.map(p => p.score));
              const winners = grid.filter(p => p.score === highestScore);
              const winnerNames = winners.map(p => p.name);
              pt.winners = winnerNames.join(', ');
            }
            this.addTournament(pt);
            this.pendingTournaments.splice(i, 1);
          }
        }
        this.tdMessage = '';
      }
      return true;
    }
  }
  
  public parseTDVariables(msg: string) {
    const lines = msg.split(/[\r\n]+/);
    lines.forEach((line) => {
      const match = line.match(/^:(\w+):\s+(\S+)/);
      if(match)
        this.tdVariables[match[1]] = match[2];
    });
  }

  public parseTDListKoTHs(msg: string): any[] {
    const lines = msg.split(/[\r\n]+/);
    const koths: any = [];
    lines.forEach((line) => {
      const match = line.match(/^:\|\s+(\d+)\s+\|\s+(\S+)\s+\|\s+(.*?)\s+\|\s+(\S+)\s+\|\s+(\S+)\s+\|/);
      if(match) {
        const koth = {
          id: +match[1],
          open: match[2] === 'Yes',
          type: match[3],
          king: match[4],
          kingStats: null,
          game: match[5],
          opponent: undefined,
        }
        koths.push(koth);
      }
    });
    return koths;
  }

  public parseTDListTourneys(msg: string): any[] {
    const lines = msg.split(/[\r\n]+/);
    const tourneys: any = [];
    lines.forEach((line) => {
      const match = line.match(/^:\|\s+(\d+)\s+\|\s+([>+]*)(\w+)([<*]*)\s+\|\s+(\w+)\s+\|\s+(.*?)\s+\|\s+(-+|(\d{4})\.(\d{2})(\d{2})\.(\d{2})(\d{2}))\s+\|/);
      if(match) {
        const tourney = {
          id: +match[1],
          joined: match[2] === '>',
          joinable: match[2] === '+',
          status: match[3],
          running: match[4] === '<',
          manager: match[5],
          type: match[6],
          date: match[7].startsWith('-') ? null : {
            year: match[8],
            month: match[9],
            day: match[10],
            hour: match[11],
            minute: match[12],
          },
        }
        tourneys.push(tourney);
      }
    });
    return tourneys;
  }  

  public parseTDPlayers(msg: string) {
    const lines = msg.split(/[\r\n]+/);
    const players: any = [];
    lines.forEach((line) => {
      const match = line.match(/^:\|\s+(\d+)\s+\|\s+([^\w\s])(\w+(?:\(\w+\))?)\(([\d\-\+]+)\)\s+\|\s+([^\w\s])?(\w+)\s+\|/);
      if(match) {
        players.push({
          id: match[1],
          playerStatus: match[2],
          name: match[3],
          rating: match[4],
          matchRequestStatus: match[5],
          status: match[6],
        });
      }
    });
    return players;
  }

  public parseTDStandardGrid(msg: string) {
    const lines = msg.split(/[\r\n]+/);
    const players: any = [];
    lines.forEach((line) => {
      const match = line.match(/^:\|\s+(\d+)\s+\|\s+([^\w\s])(\w+(?:\(\w+\))?)\(([\d\-\+]+)\)\s+\|\s+(.*?)\s+\|/);
      if(match) {
        const roundStrings = match[5].split(/\s+/);
        const rounds = roundStrings.map(str => {
          const match = str.match(/^([^\d\s])(\d+([wb])|bye)$/);
          if(match) {
            return {
              result: match[1],
              opponent: match[2],
              color: match[3]
            }
          }
        });

        const score = rounds.reduce((acc, round) => {
          if(round.result === '+')
            return acc + 1;
          else if(round.result === '=')
            return acc + 0.5;
          else
            return acc;
        }, 0);

        players.push({
          seed: +match[1],
          plusMinus: match[2],
          name: match[3],
          rating: match[4],
          rounds,
          score,
        });
      }
    });
    return players;
  }

  public addTournament(data: any) {
    let card = null;
    if(data.title) 
      card = $(`[data-tournament-title="${data.title}"]`);
    else if(data.id)
      card = $(`[data-tournament-id="${data.id}"]`);
    if(!card || !card.length) {
      card = $(`
        <div class="card tournament-card" data-tournament-type="tournament" data-event-id="${data.eventid}">
          <div class="card-body d-flex">
            <div>
              <div class="tournament-title" style="font-weight: bold;"></div>
              <div class="tournament-type" style="white-space: pre;"></div>
              <div class="tournament-date" style="white-space: pre;"></div>
              <div class="tournament-num-players" style="white-space: pre;"></div>
              <div class="tournament-winners" style="white-space: pre;"></div>
            </div>
            <div class="d-flex flex-grow-1" style="justify-content: end; align-items: center">
              <div class="btn-group-vertical" style="gap: 10px">
                <button type="button" class="btn btn-outline-secondary btn-md tournament-notify" title="Notify Me" style="display: none">Notify Me</button>
                <button type="button" class="btn btn-outline-secondary btn-md tournament-unnotify" title="Stop Notifying" style="display: none">Stop Notifying</button>
                <button type="button" class="btn btn-outline-secondary btn-md tournament-standings" title="Standings" style="display: none">Standings</button>
                <button type="button" class="btn btn-outline-secondary btn-md tournament-join" title="Join" style="display: none">Join</button>
                <button type="button" class="btn btn-outline-secondary btn-md tournament-withdraw" title="Withdraw" style="display: none">Withdraw</button>
              </div>
            </div>
          </div>
        </div>
      `);
      card.data('tournament-data', {});

      card.find('.tournament-notify, .tournament-unnotify').on('click', (e) => {
        const tourney = card.data('tournament-data');
        const notify = $(e.target).hasClass('tournament-notify');
        if(notify) 
          this.tournamentsReceiveInfo = true;

        this.notifyList[tourney.title] = notify;
        this.updateGroup('tournament');
      });
    }

    const tourney = card.data('tournament-data');

    if(!data.update) {
      const tourneyDate = tourney.date 
          ? (new Date(tourney.date.year, tourney.date.month - 1, tourney.date.day)).getTime()
          : 0;
      const dataDate = data.date 
          ? (new Date(data.date.year, data.date.month - 1, data.date.day)).getTime()
          : 0;
      if(!data.running && (tourney.running || dataDate - tourneyDate < 0))
        return; 
    }
    data.update = false;

    Object.assign(tourney, data);

    if(!tourney.running) {
      tourney.joinable = false;
      tourney.joined = false;
    }

    const inTournament = this.tdVariables.tourney === 'On';

    card.toggleClass('tournament-card-active', tourney.running); 

    if(tourney.title) {
      tourney.notify = this.notifyList[tourney.title];

      card.attr('data-tournament-title', tourney.title);
      const [title, time] = tourney.title.split(/ at ([:\d]+)$/).filter(Boolean);
      tourney.scheduledTime = time;
      card.find('.tournament-title').text(`${title}`);
    }
    const typeStr = `<span class="tournament-card-label">Type:</span>  ${tourney.type}`; 
    card.find('.tournament-type').html(typeStr);
    
    const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    let dateStr = '';
    let serverDT: any, nextDT: Date, lastDT: Date;
    const now = new Date();
    if(tourney.recurring === 'daily' || weekdays.includes(tourney.recurring)) {
      serverDT = convertToServerDateTime(now, weekdays.includes(tourney.recurring) ? tourney.recurring : undefined);
      if(tourney.scheduledTime) {
        serverDT.hour = tourney.scheduledTime.split(':')[0];
        serverDT.minute = tourney.scheduledTime.split(':')[1];
      }
      nextDT = convertToLocalDateTime(serverDT, true);
    }

    lastDT = tourney.date 
        ? convertToLocalDateTime(tourney.date, true)
        : new Date();
    if(!nextDT && (tourney.running || lastDT.getTime() - Date.now() > 0)) 
        nextDT = lastDT;

    const currentDT = nextDT || lastDT;
    tourney.timestamp = currentDT.getTime();

    const timeStr = currentDT.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });
    if(tourney.recurring === 'daily')
      dateStr = 'Every day';
    else if(weekdays.includes(tourney.recurring))
      dateStr = weekdays[currentDT.getDay()];
    else
      dateStr = this.formatDateRelative(currentDT);

    const whenStr = `<span class="tournament-card-label">${nextDT ? 'When:' : 'Last Held:'}</span>  ${dateStr}, ${timeStr}`;
    card.find('.tournament-date').html(whenStr);
    
    const numPlayersStr = tourney.numPlayers && tourney.running
        ? `<span class="tournament-card-label">Num of Players:</span>  ${tourney.numPlayers}`
        : '';
    card.find('.tournament-num-players').html(numPlayersStr);
    
    const ageInDays = lastDT ? getDiffDays(lastDT) : undefined;

    if(tourney.running)
      tourney.winners = '';
    let winnersStr = '';
    if(tourney.winners) {
      console.log('WINNER: ',tourney.winners);
      winnersStr = ageInDays === 0
          ? `<span class="tournament-card-label">Winner${tourney.winners.includes(',') ? 's' : ''}:</span>  ${tourney.winners}`
          : `<span class="tournament-card-label">Last Winner${tourney.winners.includes(',') ? 's' : ''}:</span>  ${tourney.winners}  <a href="javascript:void(0)">(Standings)</a>`;
    }
    card.find('.tournament-winners').html(winnersStr);

    if(tourney.id !== undefined) {
      card.find('.tournament-join').attr('onclick', `sessionSend('td join ${tourney.id}')`);
      card.find('.tournament-withdraw').attr('onclick', `sessionSend('td withdraw ${tourney.id}')`);
      card.find('.tournament-standings').attr('onclick', `sessionSend('td standings ${tourney.id}')`);
    }
    const notify = tourney.notify === true || (tourney.notify !== false && this.tournamentsShowNotifications);
    card.find('.tournament-notify').toggle(!tourney.running && !!nextDT && !notify);
    card.find('.tournament-unnotify').toggle(!tourney.running && !!nextDT && notify);
    card.find('.tournament-join').toggle(!!tourney.joinable && !inTournament);
    card.find('.tournament-withdraw').toggle(!!tourney.joined);
    card.find('.tournament-standings').toggle(!!tourney.winners && ageInDays === 0);
  
    this.addTournamentCard(card, 'tournament');
  }

  updateGroup(groupName: string) {
    if(groupName === 'tournament') {
      const group = $('[data-group-name="tournament"]');   
      if(group.length) {
        let checkMark = group.find('.show-notifications .checkmark');
        checkMark.toggleClass('invisible', !this.tournamentsShowNotifications);
        storage.set('tournaments-show-notifications', String(this.tournamentsShowNotifications));

        checkMark = group.find('.receive-info .checkmark');
        checkMark.toggleClass('invisible', !this.tournamentsReceiveInfo);
        storage.set('tournaments-receive-info', String(this.tournamentsReceiveInfo));

        storage.set('tournaments-notify-list', JSON.stringify(this.notifyList));
        this.updateAllTournaments({});
      }
    }
    else if(groupName === 'koth') {
      const group = $('[data-group-name="koth"]');   
      if(group.length) {
        let checkMark = group.find('.show-notifications .checkmark');
        checkMark.toggleClass('invisible', !this.kothShowNotifications);
        storage.set('koth-show-notifications', String(this.kothShowNotifications));

        checkMark = group.find('.receive-info .checkmark');
        checkMark.toggleClass('invisible', !this.kothReceiveInfo);
        storage.set('koth-receive-info', String(this.kothReceiveInfo));

        group.find('.tournament-group-title').text(`${this.tdVariables.Female === 'Yes' ? 'Queen' : 'King'} of the Hill`);
        checkMark = group.find('.set-female .checkmark');
        checkMark.toggleClass('invisible', this.tdVariables.Female !== 'Yes');

        this.updateAllKoTHs({});
      }
    }
  }

  public formatDateRelative(date: Date, now = new Date()) {
    const options: any = { month: 'short', day: 'numeric' };

    const diffDays = getDiffDays(date, now);
    if(diffDays === 0)
      return 'Today';
    else if(diffDays === 1)
      return 'Tomorrow';
    else if(diffDays === -1)
      return 'Yesterday';
    else if (diffDays > 1 && diffDays < 7)
      return date.toLocaleDateString(undefined, { weekday: 'short' }); // e.g., "Wed"
    else {
      if(date.getFullYear() !== now.getFullYear()) 
        options.year = 'numeric';
      return date.toLocaleDateString(undefined, options); // e.g., "Sep 13" or "Sep 13, 2025"
    }
  }

  public addKoTH(data: any) {
    let card = $(`[data-tournament-id="${data.id}"]`);
    if(!card.length) {
      card = $(`
        <div class="card tournament-card koth-card" data-tournament-type="koth" data-tournament-id="${data.id}">
          <div class="card-body d-flex">
            <div>
              <div class="koth-title" style="font-weight: bold;"></div>
              <div class="koth-king" style="white-space: pre;"></div>
              <div class="koth-king-stats" style="white-space: pre;"></div>
              <div class="koth-challenger" style="white-space: pre;"></div>
            </div>
            <div class="d-flex flex-grow-1" style="justify-content: end; align-items: center">
              <div class="btn-group-vertical" style="gap: 10px">
                <button type="button" class="btn btn-outline-secondary btn-md koth-claim-throne" title="Claim Throne" style="display: none" onclick="sessionSend('td claimthrone ${data.id}')">Claim Throne</button>
                <button type="button" class="btn btn-outline-secondary btn-md koth-seek" title="Seek Game" style="display: none" onclick="sessionSend('seek ${data.type}')">Seek Game</button>
                <button type="button" class="btn btn-outline-secondary btn-md koth-unseek" title="Stop Seeking" style="display: none">Stop Seeking</button>
                <button type="button" class="btn btn-outline-secondary btn-md koth-abdicate" title="Abdicate" style="display: none" onclick="sessionSend('td abdicate ${data.id}')">Abdicate</button>
                <button type="button" class="btn btn-outline-secondary btn-md koth-challenge" title="Challenge" style="display: none" onclick="sessionSend('td matchking ${data.id}')">Challenge</button>
                <button type="button" class="btn btn-outline-secondary btn-md koth-withdraw" title="Withdraw" style="display: none"">Withdraw</button>
                <button type="button" class="btn btn-outline-secondary btn-md koth-watch" title="Watch" style="display: none" onclick="sessionSend('td observekoth ${data.id}')">Observe</button>
                <button type="button" class="btn btn-outline-secondary btn-md koth-follow" title="Follow" style="display: none" onclick="sessionSend('td followking ${data.id}')">Follow King</button>
                <button type="button" class="btn btn-outline-secondary btn-md koth-unfollow" title="Unfollow" style="display: none" onclick="sessionSend('td followking')">Unfollow King</button>
              </div>
            </div>
          </div>
        </div>
      `);
      card.data('tournament-data', {});
      this.addTournamentCard(card, 'koth');
    }

    const koth = card.data('tournament-data');
    Object.assign(koth, data);
   
    if(koth.game !== '-' || koth.king === '-') 
      koth.challenge = koth.seek = undefined;
   
    const gameInProgress = !!koth.opponent || koth.game !== '-';
    const user = this.session.getUser();

    card.toggleClass('tournament-card-active', koth.king !== '-'); 

    koth.title = `KoTH ${koth.type.slice(0, -1)}`;
    card.find('.koth-title').text(koth.title);
    const isFemale = this.tdVariables.Female === 'Yes';
    const kingStr = `<span class="tournament-card-label">The ${isFemale ? 'Queen' : 'King'}:</span>  ${koth.king !== '-' ? '<i class="fa-solid fa-crown"></i>' : ''} ${koth.king}`; 
    card.find('.koth-king').html(kingStr);
    const kingStats = koth.kingStats;
    const kingStatsStr = kingStats 
        ? `<span class="tournament-card-label">Streak:</span>  ${kingStats.wins} wins, ${kingStats.draws} draws`
        : '';
    card.find('.koth-king-stats').html(kingStatsStr);
    const challengerStr = koth.opponent 
        ? `<span class="tournament-card-label">Challenger:</span>  ${koth.opponent}`
        : ''; 
    card.find('.koth-challenger').html(challengerStr);
    card.find('.koth-claim-throne').toggle(koth.open && koth.king === '-');
    card.find('.koth-seek').toggle(koth.king === user && !gameInProgress && !koth.seek);
    if(koth.seek)
      card.find('.koth-unseek').attr('onclick', `sessionSend('unseek ${data.seek}')`);
    card.find('.koth-unseek').toggle(koth.king === user && !gameInProgress && !!koth.seek);
    card.find('.koth-abdicate').toggle(koth.king === user && !gameInProgress);
    card.find('.koth-challenge').toggle(koth.open && koth.king !== '-' && !gameInProgress && koth.king !== user && koth.challenge === undefined);
    card.find('.koth-withdraw').attr('onclick', `sessionSend('withdraw ${koth.challenge}')`);
    card.find('.koth-withdraw').toggle(koth.open && koth.king !== '-' && !gameInProgress && koth.king !== user && koth.challenge !== undefined);
    card.find('.koth-watch').toggle(gameInProgress && koth.king !== user && koth.opponent !== user);
    card.find('.koth-follow').toggle(koth.king !== '-' && koth.king !== user && !koth.following);
    card.find('.koth-unfollow').toggle(koth.king !== '-' && koth.king !== user && !!koth.following);
  }

  public updateKoTH(id: number, data: any, alert?: boolean) {
    const card = $(`[data-tournament-id="${id}"]`);
    if(card.length) {
      data.id = id;
      this.addKoTH(data);
    }
    if(alert === true) {
      const tab = $('button[data-bs-target="#pills-tournaments"]');
      if(!tab.hasClass('active') || !$('#pills-play').hasClass('active')) 
        tab.addClass('tournaments-unviewed');
      this.alerts[id] = true;
    }
    else if(alert === false) {
      delete this.alerts[id];
      if(!this.alerts.length) {
        const tab = $('button[data-bs-target="#pills-tournaments"]');
        tab.removeClass('tournaments-unviewed');
      }
    }
    this.updateKoTHNotification(id, data);
  }

  public updateKoTHNotification(id: number, data: any) {
    const nElement = $(`[data-koth-id="${id}"`);
    if(!nElement.length)
      return;

    const challengeBtn = nElement.find('.button-success');
    const followBtn = nElement.find('.button-failure');

    if(data.king === '-' || data.opponent === this.session.getUser()) {
      removeNotification(nElement);
      return;
    }

    if(data.hasOwnProperty('opponent'))
      challengeBtn.toggle(!data.opponent && this.session.isRegistered());
    followBtn.toggle(this.kothFollowKing !== id);
  }

  public updateAllKoTHs(data: any, alert?: boolean) {
    const koths = $('[data-tournament-type="koth"]');
    koths.each((index, element) => {
      const kothData = $(element).data('tournament-data');
      this.updateKoTH(kothData.id, data, alert);
    });
  }

  public updateTournament(id: number, data: any, alert?: boolean) {
    let card;
    if(id != null) {
      data.id = id;
      card = $(`[data-tournament-id="${id}"]`);
    }
    else if(data.title) 
      card = $(`[data-tournament-title="${data.title}"]`);
    
    if(card && card.length) {
      data.update = true;
      this.addTournament(data);
    }

    if(alert === true) {
      const tab = $('button[data-bs-target="#pills-tournaments"]');
      if(!tab.hasClass('active') || !$('#pills-play').hasClass('active')) 
        tab.addClass('tournaments-unviewed');
      this.alerts[id] = true;
    }
    else if(alert === false) {
      delete this.alerts[id];
      if(!this.alerts.length) {
        const tab = $('button[data-bs-target="#pills-tournaments"]');
        tab.removeClass('tournaments-unviewed');
      }
    }
  }

  public updateAllTournaments(data: any, alert?: boolean) {
    const tourneys = $('[data-tournament-type="tournament"]');
    tourneys.each((index, element) => {
      const tourneyData = $(element).data('tournament-data');
      data.title = tourneyData.title;
      this.updateTournament(null, data, alert);
    });  
  }

  public addTournamentCard(card: JQuery<HTMLElement>, groupName: string) {  
    let group = $(`#pills-tournaments .tournament-group[data-group-name="${groupName}"]`);
    if(!group.length) {
      group = $(`
        <div class="tournament-group" data-group-name="${groupName}">
          <div class="tournament-group-header d-flex align-items-center">
            <span class="tournament-group-title">Tournaments</span>
            <button type="button" class="tournament-more-options ms-auto btn btn-outline-secondary btn-sm btn-transparent dropdown-toggle hide-caret position-relative" data-bs-toggle="dropdown" aria-expanded="false" aria-label="More options">
              <div class="tooltip-overlay" data-tooltip-hover-only data-bs-toggle="tooltip" title="More options"></div>
              <span class="fa-solid fa-ellipsis-vertical" aria-hidden="false"></span>
            </button>
            <ul class="dropdown-menu dropdown-menu-end" aria-labelledby="tournament-more-options">
              <li><a class="dropdown-item noselect show-notifications"><span class="me-2 checkmark invisible">&#10003;</span>Show All Notifications</a></li>
              <li><a class="dropdown-item noselect receive-info"><span class="me-2 checkmark invisible">&#10003;</span>Receive Info</a></li>
              ${groupName === 'koth' ? '<li><a class="dropdown-item noselect set-female"><span class="me-2 checkmark invisible">&#10003;</span>Set me as Female</a></li>' : ''}
            </ul>
          </div>
          <div class="tournament-group-cards"></div>
        </div>
      `);
    
      if(groupName === 'tournament') {
        group.appendTo('#pills-tournaments');
        this.updateGroup('tournament');
        group.find('.show-notifications').on('click', (e) => {
          let checkMark = $(e.currentTarget).find('.checkmark');
          checkMark.toggleClass('invisible');
          e.stopPropagation();

          this.tournamentsShowNotifications = !checkMark.hasClass('invisible');
          if(this.tournamentsShowNotifications) 
            this.tournamentsReceiveInfo = true;

          this.notifyList = {};
          this.updateGroup('tournament');
        });

        group.find('.receive-info').on('click', (e) => {
          const checkMark = $(e.currentTarget).find('.checkmark');
          checkMark.toggleClass('invisible');
          e.stopPropagation();

          this.tournamentsReceiveInfo = !checkMark.hasClass('invisible');
          if(!this.tournamentsReceiveInfo) 
            this.tournamentsShowNotifications = false;

          this.notifyList = {};
          this.updateGroup('tournament');
        });
      }
      else if(groupName === 'koth') {
        group.appendTo('#pills-tournaments');
        this.updateGroup('koth');

        group.find('.show-notifications').on('click', (e) => {
          const checkMark = $(e.currentTarget).find('.checkmark');
          checkMark.toggleClass('invisible');
          e.stopPropagation();

          this.kothShowNotifications = !checkMark.hasClass('invisible');
          if(this.kothShowNotifications) 
            this.kothReceiveInfo = true;

          this.updateGroup('koth');
        });

        group.find('.receive-info').on('click', (e) => {
          const checkMark = $(e.currentTarget).find('.checkmark');
          checkMark.toggleClass('invisible');
          e.stopPropagation();

          this.kothReceiveInfo = !checkMark.hasClass('invisible');
          if(!this.kothReceiveInfo) 
            this.kothShowNotifications = false;
          
          this.updateGroup('koth');
        });

        group.find('.set-female').on('click', (e) => {
          const checkMark = $(e.currentTarget).find('.checkmark');
          checkMark.toggleClass('invisible');
          e.stopPropagation();

          const isFemale = !checkMark.hasClass('invisible');
          this.session.send(`td set female ${isFemale ? '1' : '0'}`);
        });
      }
    }

    this.insertChronological(card, group.find('.tournament-group-cards'));
  }

  public insertChronological(card, container) {
    const newData = card.data('tournament-data');
    const newTimestamp = newData.timestamp;
    
    if(newData.timestamp == null) {
      container.append(card);
      return;
    }

    if(newData.running) {
      container.prepend(card);
      return;
    }
    
    const now = Date.now();

    let inserted = false;
    container.children().each(function () {
      const existingData = $(this).data('tournament-data');
      const existingTimestamp = existingData.timestamp;

      const isNewFuture = newTimestamp >= now;
      const isExistingFuture = existingTimestamp >= now;

      let shouldInsertBefore = false;

      if(isNewFuture && !isExistingFuture) 
        shouldInsertBefore = true;
      else if(isNewFuture && isExistingFuture) 
        shouldInsertBefore = newTimestamp < existingTimestamp;
      else if(!isNewFuture && !isExistingFuture) 
        shouldInsertBefore = newTimestamp > existingTimestamp;

      if(shouldInsertBefore) {
        card.insertBefore(this);
        inserted = true;
        return false; 
      }
    });

    if(!inserted) 
      container.append(card);
  }

  public handleOffers(offers: any) {
    const koths = $('[data-tournament-type="koth"]');

    // Our sent offers
    const sentOffers = offers.filter((item) => (item.type === 'sn'
      || (item.type === 'pt' && item.subtype === 'match'))
      && !$(`.sent-offer[data-offer-id="${item.id}"]`).length);
    
    sentOffers.forEach((offer) => {
      const ratedUnrated = offer.ratedUnrated === 'unrated' ? 'u' : 'r';
      const type = `${offer.initialTime} ${offer.increment} ${ratedUnrated}`;

      koths.each((index, element) => {
        const kothData = $(element).data('tournament-data');
        if(offer.type === 'pt' && type === kothData.type && offer.opponent === kothData.king) {
          this.updateKoTH(kothData.id, {
            challenge: offer.id,
          });
        }
        else if(offer.type === 'sn' && type === kothData.type) {
          this.updateKoTH(kothData.id, {
            seek: offer.id,
          });
        }
      });
    });
   
    // Removals
    const removals = offers.filter(item => item.type === 'pr' || item.type === 'sr');
    removals.forEach((offer) => {
      koths.each((index, element) => {
        const kothData = $(element).data('tournament-data');
        offer.ids.forEach((id) => {
          if(offer.type === 'pr' && kothData.challenge === id) { // match request removal          
            this.updateKoTH(kothData.id, {
              challenge: undefined,
            });
          }
          else if(offer.type === 'sr' && kothData.seek === id) {
            this.updateKoTH(kothData.id, {
              seek: undefined,
            });
          }
        });
        if(offer.type === 'sr' && !offer.ids.length) {
          this.updateKoTH(kothData.id, {
            seek: undefined,
          });
        }
      });
    });
  }
}

export default Tournaments;