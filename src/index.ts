// Copyright 2023 Free Chess Club.
// Use of this source code is governed by a GPL-style
// license that can be found in the LICENSE file.

import Chess from 'chess.js';
import { Chessground } from 'chessground';
import { Color, Key } from 'chessground/types';
import { Polyglot } from 'cm-polyglot/src/Polyglot.js';
import PgnParser from '@mliebelt/pgn-parser';
import NoSleep from '@uriopass/nosleep.js'; // Prevent screen dimming
import * as Utils from './utils';
import * as ChessHelper from './chess-helper';
import * as Dialogs from './dialogs';
import Chat from './chat';
import { Clock } from './clock';
import { Engine, EvalEngine } from './engine';
import { Game, GameData, Role, NewVariationMode, games } from './game';
import { History, HEntry } from './history';
import { GetMessageType, MessageType, Session } from './session';
import * as Sounds from './sounds';
import { storage, CredentialStorage } from './storage';
import { settings } from './settings';
import { Reason } from './parser';
import './ui';
import packageInfo from '../package.json';

export const enum Layout {
  Desktop = 0,
  Mobile,
  ChatMaximized
}

// The game categories (variants) that we support independantly of FICS, i.e. for offline analysis
// Currently the only FICS variants we don't support are Atomic and Suicide
// For unsupported categories, chess.js and toDests() are not used, the board is put into 'free' mode,
// and a move is not added to the move list unless it is verified by the server.
const SupportedCategories = ['blitz', 'lightning', 'untimed', 'standard', 'nonstandard', 'crazyhouse', 'bughouse', 'losers', 'wild/fr', 'wild/0', 'wild/1', 'wild/2', 'wild/3', 'wild/4', 'wild/5', 'wild/8', 'wild/8a'];

let session: Session;
let chat: Chat;
let engine: Engine | null;
let evalEngine: EvalEngine | null;
let playEngine: Engine | null;
let historyRequested = 0;
let obsRequested = 0;
let allobsRequested = 0;
let gamesRequested = false;
let lobbyRequested = false;
let channelListRequested = false;
let computerListRequested = false;
let setupBoardPending = false;
let gameExitPending = [];
let examineModeRequested: Game | null = null;
let mexamineRequested: Game | null = null;
let mexamineGame: Game | null = null;
let computerList = [];
let numPVs = 1;
let matchRequested = 0;
let prevSizeCategory = null;
let layout = Layout.Desktop;
let soundTimer
let showSentOffersTimer; // Delay showing new offers until the user has finished clicking buttons
let newSentOffers = []; // New sent offers (match requests and seeks) that are waiting to be displayed
let activeTab;
let newTabShown = false;
let newGameVariant = '';
let lobbyEntries = new Map();
let lobbyScrolledToBottom;
let noSleep = new NoSleep(); // Prevent screen dimming
let openings; // Opening names with corresponding moves
let fetchOpeningsPromise = null;
let book; // Opening book used in 'Play Computer' mode
let isRegistered = false;
let lastComputerGame = null; // Attributes of the last game played against the Computer. Used for Rematch and alternating colors each game.
let partnerGameId = null;
let lastPointerCoords = {x: 0, y: 0}; // Stores the pointer coordinates from the last touch/mouse event
let credential: CredentialStorage = null; // The persistently stored username/password
const mainBoard: any = createBoard($('#main-board-area').children().first().find('.board'));

/**
 * Used to call session.send() from inline JS.
 */
(window as any).sessionSend = (cmd: string) => {
  session.send(cmd);
};

/************************************************
 * INITIALIZATION AND TOP LEVEL EVENT LISTENERS *
 ************************************************/

jQuery(() => {
  if ((window as any).cordova !== undefined) {
    document.addEventListener('deviceready', onDeviceReady, false);
  } else {
    onDeviceReady();
  }
});

async function onDeviceReady() {
  await storage.init();
  initSettings();

  if((window as any).Capacitor !== undefined) {
    (window as any).Capacitor.Plugins.SafeArea.enable({
      config: {
        customColorsForSystemBars: false
      },
    });
  }

  chat = new Chat();
  
  const game = createGame();
  game.role = Role.NONE;
  game.category = 'untimed';
  game.history = new History(game, new Chess().fen());
  setGameWithFocus(game);

  disableOnlineInputs(true);

  if(Utils.isSmallWindow()) {
    $('#collapse-chat').collapse('hide');
    $('#collapse-menus').collapse('hide');
    setViewModeList();
  }
  else {
    Utils.createTooltips();
    $('#pills-play-tab').tab('show');
    $('#collapse-menus').removeClass('collapse-init');
    $('#collapse-chat').removeClass('collapse-init');
    $('#chat-toggle-btn').toggleClass('toggle-btn-selected');
  }

  $('input, textarea').each(function() {
    Utils.selectOnFocus($(this));
  });

  // Change layout for mobile or desktop and resize panels
  // Split it off into a timeout so that onDeviceReady doesn't take too long.
  setTimeout(() => { $(window).trigger('resize'); }, 0);

  credential = new CredentialStorage();
  if(settings.rememberMeToggle) 
    await credential.retrieve(); // Get the username/password from secure storage (if the user has previously ticked Remember Me)
  else {
    $('#login-user').val('');
    $('#login-pass').val('');
  }  

  if(credential.username != null && credential.password != null) {
    session = new Session(messageHandler, credential.username, credential.password);
  } else {
    session = new Session(messageHandler);
  }

  Utils.initDropdownSubmenus();
}

$(window).on('load', function() {
  $('#left-panel-header').css('visibility', 'visible');
  $('#right-panel-header').css('visibility', 'visible');
});

/** Prompt before unloading page if in a game */
$(window).on('beforeunload', () => {
  const game = games.getPlayingExaminingGame();
  if(game && game.isPlaying())
    return true;
});

// Prevent screen dimming, must be enabled in a user input event handler
$(document).one('click', (event) => {
  if(settings.wakelockToggle) {
    noSleep.enable();
  }
});

// Used to keep track of the mouse coordinates for displaying menus at the mouse
$(document).on('mouseup mousedown touchend touchcancel', (event) => {
  lastPointerCoords = Utils.getTouchClickCoordinates(event);
});
document.addEventListener('touchstart', (event) => {
  lastPointerCoords = Utils.getTouchClickCoordinates(event);
}, {passive: true});

// Hide popover if user clicks anywhere outside
$('body').on('click', function (e) {
  if(!$('#rated-unrated-menu').is(e.target)
      && $('#rated-unrated-menu').has(e.target).length === 0
      && $('.popover').has(e.target).length === 0)
    $('#rated-unrated-menu').popover('dispose');
});

$(document).on('keydown', (e) => {
  if(e.key === 'Enter') {
    const blurElement = $(e.target).closest('.blur-on-enter');
    if(blurElement.length) {
      blurElement.trigger('blur');
      e.preventDefault();
      return;
    }
  }

  if($(e.target).closest('input, textarea, [contenteditable]')[0])
    return;

  if(e.key === 'ArrowLeft')
    backward();

  else if(e.key === 'ArrowRight')
    forward();
});

/*******************************
 * RESIZE AND LAYOUT FUNCTIONS *
 *******************************/

$(window).on('resize', () => {
  if(!$('#mid-col').is(':visible'))
    layout = Layout.ChatMaximized;
  else if(layout === Layout.ChatMaximized)
    layout = Layout.Desktop;

  if(Utils.isSmallWindow() && layout === Layout.Desktop)
    useMobileLayout();
  else if(!Utils.isSmallWindow() && layout === Layout.Mobile)
    useDesktopLayout();

  setPanelSizes();
  setFontSizes();

  prevSizeCategory = Utils.getSizeCategory();

  if(evalEngine)
    evalEngine.redraw();
});

function setPanelSizes() {
  // Reset player status panels that may have been previously slimmed down on single column screen
  const maximizedGame = games.getMainGame();
  const maximizedGameCard = maximizedGame.element;
  const topPanel = maximizedGameCard.find('.top-panel');
  const bottomPanel = maximizedGameCard.find('.bottom-panel');

  if(!Utils.isSmallWindow() && prevSizeCategory === Utils.SizeCategory.Small) {
    topPanel.css('height', '');
    bottomPanel.css('height', '');
  }

  // Make sure the board is smaller than the window height and also leaves room for the other columns' min-widths
  if(!Utils.isSmallWindow()) {
    const scrollBarWidth = Utils.getScrollbarWidth();

    // Set board width a bit smaller in order to leave room for a scrollbar on <body>. This is because
    // we don't want to resize all the panels whenever a dropdown or something similar overflows the body.
    const cardMaxWidth = Utils.isMediumWindow() // display 2 columns on md (medium) display
      ? window.innerWidth - $('#left-col').outerWidth() - scrollBarWidth
      : window.innerWidth - $('#left-col').outerWidth() - parseFloat($('#right-col').css('min-width')) - scrollBarWidth;

    const cardMaxHeight = $(window).height() - Utils.getRemainingHeight(maximizedGameCard);
    setGameCardSize(maximizedGame, cardMaxWidth, cardMaxHeight);
  }
  else
    setGameCardSize(maximizedGame);

  // Set the height of dynamic elements inside left and right panel collapsables.
  // Try to do it in a robust way that won't break if we add/remove elements later.

  // On mobile, slim down player status panels in order to fit everything within window height
  if(Utils.isSmallWindow()) {
    const originalStatusHeight = $('#left-panel-header').height();
    const cardBorders = maximizedGameCard.outerHeight() - maximizedGameCard.height()
      + Math.round(parseFloat($('#left-card').css('border-bottom-width')))
      + Math.round(parseFloat($('#right-card').css('border-top-width')));
    const playerStatusBorder = maximizedGameCard.find('.top-panel').outerHeight() - maximizedGameCard.find('.top-panel').height();
    const safeAreas = $('body').innerHeight() - $('body').height();
    let playerStatusHeight = ($(window).height() - safeAreas - $('#board-card').outerHeight(true) - $('#left-panel-footer').outerHeight() - $('#right-panel-header').outerHeight() - cardBorders) / 2 - playerStatusBorder;
    playerStatusHeight = Math.min(Math.max(playerStatusHeight, originalStatusHeight - 20), originalStatusHeight);

    topPanel.height(playerStatusHeight);
    bottomPanel.height(playerStatusHeight);
  }

  // These variables are used to resize status panel elements based on the width / height of the panel using CSS
  topPanel.css('--panel-height', topPanel.css('height'));
  topPanel.css('--panel-width', topPanel.css('width'));
  bottomPanel.css('--panel-height', bottomPanel.css('height'));
  bottomPanel.css('--panel-width', bottomPanel.css('width'));

  setLeftColumnSizes();
  setRightColumnSizes();

  // Adjust Notifications drop-down width
  if(Utils.isSmallWindow() && prevSizeCategory !== Utils.SizeCategory.Small)
    $('#notifications').css('width', '100%');
  else if(Utils.isMediumWindow() && prevSizeCategory !== Utils.SizeCategory.Medium)
    $('#notifications').css('width', '50%');
  else if(Utils.isLargeWindow())
    $('#notifications').width($(document).outerWidth(true) - $('#left-col').outerWidth(true) - $('#mid-col').outerWidth(true));
}

function setLeftColumnSizes() {
  const boardHeight = $('#main-board-area .board').innerHeight();

  // set height of left menu panel inside collapsable
  if (boardHeight) {
    if($('#left-panel').height() === 0)
      $('#left-panel-bottom').css('height', '');

    if(Utils.isSmallWindow())
      $('#left-panel').css('height', ''); // Reset back to CSS defined height
    else {
      const remHeight = Utils.getRemainingHeight($('#left-panel'), $('#inner-left-panels'));
      const leftPanelBorder = $('#left-panel').outerHeight(true) - $('#left-panel').height();
      const leftPanelHeight = boardHeight - remHeight - leftPanelBorder;
      $('#left-panel').height(Math.max(leftPanelHeight, 0));
      // If we've made the left panel height as small as possible, reduce size of status panel instead
      // Note leftPanelHeight is negative in that case
      if(leftPanelHeight < 0)
        $('#left-panel-bottom').height($('#left-panel-bottom').height() + leftPanelHeight);
    }
  }
}

function setGameCardSize(game: Game, cardMaxWidth?: number, cardMaxHeight?: number) {
  const card = game.element;
  const roundingCorrection = (card.hasClass('game-card-sm') ? 0.032 : 0.1);
  let cardWidth: number;

  if(cardMaxWidth !== undefined || cardMaxHeight !== undefined) {
    const cardBorderWidth = card.outerWidth() - card.width();
    let boardMaxWidth = cardMaxWidth - cardBorderWidth;
    
    const cardBorderHeight = card.outerHeight() - card.height();
    const remHeight = card.outerHeight() - card.find('.card-body').height();
    let boardMaxHeight = cardMaxHeight - remHeight;

    if(!cardMaxWidth)
      boardMaxWidth = boardMaxHeight;
    if(!cardMaxHeight)
      boardMaxHeight = boardMaxWidth;

    cardWidth = Math.min(boardMaxWidth, boardMaxHeight) - (2 * roundingCorrection); // Subtract small amount for rounding error
  }
  else {
    card.css('width', '');
    cardWidth = card.width();
  }

  // Recalculate the width of the board so that the squares align to integer pixel boundaries, this is to match
  // what chessground does internally
  cardWidth = (Math.floor((cardWidth * window.devicePixelRatio) / 8) * 8) / window.devicePixelRatio + roundingCorrection;

  // Set card width
  card.width(cardWidth);
  game.board.redrawAll();
}

function setRightColumnSizes() {
  const boardHeight = $('#main-board-area .board').innerHeight();
   // Set chat panel height to 0 before resizing everything so as to remove scrollbar on window caused by chat overflowing
  if(Utils.isLargeWindow())
    $('#chat-panel').height(0);

  // Set width and height of game cards in the right board area
  const numCards = $('#secondary-board-area').children().length;
  if(numCards > 2)
    $('#secondary-board-area').css('overflow-y', 'scroll');
  else
    $('#secondary-board-area').css('overflow-y', 'hidden');
 
  for(let game of games) {
    if(game.element.parent().is($('#secondary-board-area'))) {
      const cardsPerRow = Utils.isLargeWindow() ? Math.min(2, numCards) : 2;
      const cardHeight = Utils.isLargeWindow() ? boardHeight * 0.6 : null;

      const boardAreaScrollbarWidth = $('#secondary-board-area')[0].offsetWidth - $('#secondary-board-area')[0].clientWidth;
      const innerWidth = $('#secondary-board-area').width() - boardAreaScrollbarWidth - 1;
      setGameCardSize(game, innerWidth / cardsPerRow - parseInt($('#secondary-board-area').css('gap')) * (cardsPerRow - 1) / cardsPerRow, cardHeight);

      // These variables are used to resize status panel elements based on the width / height of the panel
      const topPanel = game.element.find('.top-panel');
      topPanel.css('--panel-height', topPanel.css('height'));
      topPanel.css('--panel-width', topPanel.css('width'));
      const bottomPanel = game.element.find('.bottom-panel');
      bottomPanel.css('--panel-height', bottomPanel.css('height'));
      bottomPanel.css('--panel-width', bottomPanel.css('width'));
    }
  }

  if(Utils.isSmallWindow())
    $('#secondary-board-area').css('height', '');
  else
    $('#secondary-board-area').height($('#secondary-board-area > :first-child').outerHeight());

  if(!Utils.isLargeWindow() || !boardHeight) {
    const hasSiblings = $('#collapse-chat').siblings(':visible').length > 0; // If there are game boards in the right column, then don't try to fit the header and chat into the same screen height
    const border = $('#chat-panel').outerHeight(true) - $('#chat-panel').height();
    $('#chat-panel').height($(window).height() - Utils.getRemainingHeight($('#chat-panel'), $('body'), `#collapse-chat ${hasSiblings ? ', #inner-right-panels' : ''}`) - border);
  }
  else {
    const remHeight = Utils.getRemainingHeight($('#chat-panel'), $('#inner-right-panels'));
    const chatPanelBorder = $('#chat-panel').outerHeight(true) - $('#chat-panel').height();
    $('#chat-panel').height(boardHeight + $('#left-panel-footer').outerHeight() - remHeight - chatPanelBorder);
  }

  adjustInputTextHeight();
  if(chat)
    chat.fixScrollPosition();
}

function calculateFontSize(container: any, containerMaxWidth: number, minWidth?: number, maxWidth?: number) {
  if(minWidth === undefined)
    minWidth = +$('body').css('font-size').replace('px', '');
  if(maxWidth === undefined)
    maxWidth = +container.css('font-size').replace('px', '');

  const fontFamily = container.css('font-family');
  const fontWeight = container.css('font-weight');

  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");

  function getTextWidth(text, font) {
    context.font = font;
    var metrics = context.measureText(text);
    return metrics.width;
  }

  let fontSize = maxWidth + 1; // Initial font size
  let textWidth: number;
  do {
    fontSize--;
    textWidth = getTextWidth(container.text(), `${fontWeight} ${fontSize}px ${fontFamily}`);
  } while (textWidth > containerMaxWidth && fontSize > minWidth);
  return fontSize;
}

// If on small screen device displaying 1 column, move the navigation buttons so they are near the board
function useMobileLayout() {
  swapLeftRightPanelHeaders();
  moveLeftPanelSetupBoard();
  $('#chat-maximize-btn').hide();
  $('#viewing-games-buttons:visible:last').removeClass('me-0');
  $('#stop-observing').appendTo($('#viewing-game-buttons').last());
  $('#stop-examining').appendTo($('#viewing-game-buttons').last());
  $('#viewing-games-buttons:visible:last').addClass('me-0'); // This is so visible buttons in the btn-toolbar center properly
  hidePanel('#left-panel-header-2');

  Utils.createTooltips();
  layout = Layout.Mobile;
}

function useDesktopLayout() {
  swapLeftRightPanelHeaders();
  moveLeftPanelSetupBoard();
  $('#chat-maximize-btn').show();
  $('#stop-observing').appendTo($('#left-panel-header-2').last());
  $('#stop-examining').appendTo($('#left-panel-header-2').last());
  if(games.focused.isObserving() || games.focused.isExamining())
    showPanel('#left-panel-header-2');

  Utils.createTooltips();
  layout = Layout.Desktop;
}

function swapLeftRightPanelHeaders() {
  // Swap top left and top right panels to bring navigation buttons closer to board
  const leftHeaderContents = $('#left-panel-header').children();
  const rightHeaderContents = $('#right-panel-header').children();
  rightHeaderContents.appendTo($('#left-panel-header'));
  leftHeaderContents.appendTo($('#right-panel-header'));

  const leftHeaderClass = $('#left-panel-header').attr('class');
  const rightHeaderClass = $('#right-panel-header').attr('class');
  $('#left-panel-header').attr('class', rightHeaderClass);
  $('#right-panel-header').attr('class', leftHeaderClass);

  if(Utils.isSmallWindow()) {
    $('#chat-toggle-btn').appendTo($('#chat-collapse-toolbar').last());
    $('#menus-toggle-btn').appendTo($('#left-panel-header .btn-toolbar').last());
  }
  else {
    $('#chat-toggle-btn').appendTo($('#right-panel-header .btn-toolbar').last());
    $('#menus-toggle-btn').appendTo($('#navigation-toolbar').last());
  }
}

/*********************************************
 * MAIN MESSAGE PUMP                         *
 * Process messages received from the server *
 *********************************************/
function messageHandler(data: any) {
  if(data == null) 
    return;

  const type = GetMessageType(data);
  switch (type) {
    case MessageType.Control:
      if(!session.isConnected() && data.command === 1) { // Connected
        cleanup();
        disableOnlineInputs(false);
        session.setUser(data.control);
        chat.setUser(data.control);
        session.send('set seek 0');
        session.send('set echo 1');
        session.send('set style 12');
        session.send(`set interface Free Chess Club (${packageInfo.version})`);
        session.send('iset defprompt 1'); // Force default prompt. Used for splitting up messages
        session.send('iset nowrap 1'); // Stop chat messages wrapping which was causing spaces to get removed erroneously
        session.send('iset pendinfo 1'); // Receive detailed match request info (both that we send and receive)
        session.send('iset ms 1'); // Style12 receives clock times with millisecond precision
        session.send('=ch');
        channelListRequested = true;
        session.send('=computer'); // get Computers list, to augment names in Observe panel
        computerListRequested = true;

        if($('#pills-observe').hasClass('active'))
          initObservePane();
        else if($('#pills-history').hasClass('active'))
          initHistoryPane();
        else if($('#pills-play').hasClass('active')) {
          if($('#pills-lobby').hasClass('active'))
            initLobbyPane();
          else if($('#pills-pairing').hasClass('active'))
            initPairingPane();
        }
      } 
      else if(data.command === 2) { // Login error
        session.disconnect();
        $('#session-status').popover({
          animation: true,
          content: data.control,
          placement: 'top',
        });
        $('#session-status').popover('show');
      } 
      else if(data.command === 3) { // Disconnected
        disableOnlineInputs(true);
        cleanup();
      }
      break;
    case MessageType.ChannelTell:
      chat.newMessage(data.channel, data);
      break;
    case MessageType.PrivateTell:
      chat.newMessage(data.user, data);
      break;
    case MessageType.GameMove:
      gameMove(data);
      break;
    case MessageType.GameStart:
      break;
    case MessageType.GameEnd:
      gameEnd(data);
      break;
    case MessageType.GameHoldings:
      var game = games.findGame(data.game_id);
      if(!game)
        return;
      game.history.current().variantData.holdings = data.holdings;
      showCapturedMaterial(game);
      break;
    case MessageType.Offers:
      handleOffers(data.offers);
      break;
    case MessageType.Unknown:
    default:
      handleMiscMessage(data);
      break;
  }
}

function gameMove(data: any) { 
  if(gameExitPending.includes(data.id))
    return;

  let game: Game;

  // If in single-board mode, check we are not examining/observing another game already
  if(!settings.multiboardToggle) {
    game = games.getMainGame();
    if(game.isPlayingOnline() && game.id !== data.id) {
      if(data.role === Role.OBSERVING || data.role === Role.OBS_EXAMINED)
        session.send(`unobs ${data.id}`);
      return;
    }
    else if((game.isExamining() || game.isObserving()) && game.id !== data.id) {
      if(game.isExamining()) {
        session.send('unex');
      }
      else if(game.isObserving())
        session.send(`unobs ${game.id}`);

      if(data.role === Role.PLAYING_COMPUTER)
        cleanupGame(game);
      else {
        gameExitPending.push(game.id);
        return;
      }
    }
    else if(game.role === Role.PLAYING_COMPUTER && data.role !== Role.PLAYING_COMPUTER)
      cleanupGame(game); // Allow player to imemediately play/examine/observe a game at any time while playing the Computer. The Computer game will simply be aborted.
  }

  if((examineModeRequested || mexamineRequested) && data.role === Role.EXAMINING) {
    // Converting a game to examine mode
    game = examineModeRequested || mexamineRequested;
    if(game.role !== Role.NONE && settings.multiboardToggle)
      game = cloneGame(game);
    game.id = data.id;
    if(!game.wname)
      game.wname = data.wname;
    if(!game.bname)
      game.bname = data.bname;
    game.role = Role.EXAMINING;
  }
  else {
    if(settings.multiboardToggle) {
      // Get game object
      game = games.findGame(data.id);
      if(!game)
        game = games.getFreeGame();
      if(!game)
        game = createGame();
    }

    var prevRole = game.role;
    Object.assign(game, data);
  }

  // New game
  if(examineModeRequested || mexamineRequested || prevRole === Role.NONE)
    gameStart(game);

  // Make move
  if(game.setupBoard && !game.commitingMovelist) {
    updateSetupBoard(game, game.fen, true);
  }
  else if(game.role === Role.NONE || game.role >= -2 || game.role === Role.PLAYING_COMPUTER) {
    const lastFen = currentGameMove(game).fen;
    const lastPly = ChessHelper.getPlyFromFEN(lastFen);
    const thisPly = ChessHelper.getPlyFromFEN(game.fen);

    if(game.move !== 'none' && thisPly === lastPly + 1) { // make sure the move no is right
      const parsedMove = parseGameMove(game, lastFen, game.move);
      movePieceAfter(game, (parsedMove ? parsedMove.move : game.moveVerbose), game.fen);
    }
    else
      updateHistory(game, null, game.fen);

    hitClock(game, true);
  }
}

function gameStart(game: Game) {
  hidePromotionPanel(game);
  game.board.cancelMove();
  if(game === games.focused && (!game.history || !game.history.hasSubvariation()))
    $('#exit-subvariation').hide();

  // for bughouse set game.color of partner to opposite of us
  const mainGame = games.getPlayingExaminingGame();
  const partnerColor = (mainGame && mainGame.partnerGameId === game.id && mainGame.color === 'w' ? 'b' : 'w');

  // Determine the player's color
  const amIwhite = game.wname === session.getUser();
  const amIblack = (game.role === Role.PLAYING_COMPUTER && game.color === 'b') || game.bname === session.getUser();

  if((!amIblack || amIwhite) && partnerColor !== 'b')
    game.color = 'w';
  else
    game.color = 'b';

  // Set game board text
  const whiteStatus = game.element.find(game.color === 'w' ? '.player-status' : '.opponent-status');
  const blackStatus = game.element.find(game.color === 'b' ? '.player-status' : '.opponent-status');
  whiteStatus.find('.name').text(game.wname.replace(/_/g, ' '));
  blackStatus.find('.name').text(game.bname.replace(/_/g, ' '));
  if(!game.wrating)
    whiteStatus.find('.rating').text('');
  if(!game.brating)
    blackStatus.find('.rating').text('');

  if(game.isPlayingOnline() || game.isExamining() || game.isObserving()) {
    let gameType: string;
    if(game.isPlayingOnline())
      gameType = 'Playing';
    else if(game.isExamining())
      gameType = 'Examining';
    else if(game.isObserving())
      gameType = 'Observing';
    game.element.find('.title-bar-text').text(`Game ${game.id} (${gameType})`);
    const gameStatus = game.statusElement.find('.game-status');
    if(gameStatus.text())
      gameStatus.prepend(`<span class="game-id">Game ${game.id}: </span>`);
  }
  else if(game.role === Role.PLAYING_COMPUTER)
    game.element.find('.title-bar-text').text('Computer (Playing)');

  setFontSizes();

  // Set board orientation

  const flipped = game.element.find('.opponent-status').parent().hasClass('bottom-panel');
  game.board.set({
    orientation: ((game.color === 'b') === flipped ? 'white' : 'black'),
  });

  // Check if server flip variable is set and flip board if necessary
  const v_flip = game.isPlaying() ? (game.color === 'b') !== game.flip : game.flip;
  if(v_flip != flipped)
    flipBoard(game);

  // Reset HTML elements
  game.element.find('.player-status .captured').text('');
  game.element.find('.opponent-status .captured').text('');
  game.element.find('.card-header').css('--bs-card-cap-bg', '');
  game.element.find('.card-footer').css('--bs-card-cap-bg', '');
  game.element.find('.clock').removeClass('low-time');
  $('#game-pane-status').hide();
  $('#pairing-pane-status').hide();
  game.statusElement.find('.game-watchers').empty();
  game.statusElement.find('.opening-name').hide();

  if(game.isPlaying() || game.isExamining()) {
    clearMatchRequests();
    $('#game-requests').html('');
    Dialogs.hideAllNotifications();
  }

  if(game.role !== Role.PLAYING_COMPUTER && game.role !== Role.NONE) {
    session.send(`allobs ${game.id}`);
    allobsRequested++;
    if(game.isPlaying()) {
      game.watchersInterval = setInterval(() => {
        const time = game.color === 'b' ? game.btime : game.wtime;
        if (time > 20000) {
          session.send(`allobs ${game.id}`);
          allobsRequested++;
        }
      }, 30000);
    }
    else {
      game.watchersInterval = setInterval(() => {
        session.send(`allobs ${game.id}`);
        allobsRequested++;
      }, 5000);
    }
  }

  if(game === games.focused && evalEngine) {
    evalEngine.terminate();
    evalEngine = null;
  }

  if(!examineModeRequested && !mexamineRequested) {
    game.historyList.length = 0;
    game.gameListFilter = '';
    $('#game-list-button').hide();
    game.history = new History(game, game.fen, game.time * 60000, game.time * 60000);
    updateEditMode(game);
    game.analyzing = false;
    if(game.setupBoard)
      leaveSetupBoard(game, true);
  }

  if(game.isPlayingOnline())
    game.element.find($('[title="Close"]')).css('visibility', 'hidden');

  let focusSet = false;
  if(!game.isObserving() || games.getMainGame().role === Role.NONE) {
    if(game !== games.focused) {
      setGameWithFocus(game);
      focusSet = true;
    }
    maximizeGame(game);
  }
  if(!focusSet) {
    if(game === games.focused)
      initGameControls(game);
    updateBoard(game);
  }

  // Close old unused private chat tabs
  if(chat)
    chat.closeUnusedPrivateTabs();

  // Open chat tabs
  if(game.isPlayingOnline()) {
    if(game.category === 'bughouse' && partnerGameId !== null)
      chat.createTab(`Game ${game.id} and ${partnerGameId}`); // Open chat room for all bughouse participants
    else if(game.color === 'w')
      chat.createTab(game.bname);
    else
      chat.createTab(game.wname);
  }
  else if(game.isObserving() || game.isExamining()) {
    if(mainGame && game.id === mainGame.partnerGameId) { // Open chat to bughouse partner
      if(game.color === 'w')
        chat.createTab(game.wname);
      else
        chat.createTab(game.bname);
    }
    else
      chat.createTab(`Game ${game.id}`);
  }

  if(game.isPlaying() || game.isObserving()) {
    // Adjust settings for game category (variant)
    // When examining we do this after requesting the movelist (since the category is told to us by the 'moves' command)
    if(game.isPlaying()) {
      if(settings.soundToggle) {
        Sounds.startSound.play();
      }

      if(game.role === Role.PLAYING_COMPUTER) { // Play Computer mode
        playEngine = new Engine(game, playComputerBestMove, null, getPlayComputerEngineOptions(game), getPlayComputerMoveParams(game));
        if(game.turn !== game.color)
          getComputerMove(game);
      }
      else {
        $('#play-computer').prop('disabled', true);
        if(game.category === 'bughouse' && partnerGameId !== null) {
          game.partnerGameId = partnerGameId;
          partnerGameId = null;
        }
      }
    }
  }

  if(examineModeRequested) {
    setupGameInExamineMode(game);
    examineModeRequested = null;
  }
  else {
    if(game.isExamining()) {
      if(setupBoardPending) {
        setupBoardPending = false;
        setupBoard(game, true);
      }

      if(!game.setupBoard) {
        if(mexamineRequested) {
          const hEntry = game.history.find(game.fen);
          if(hEntry)
            game.history.display(hEntry);

          const moves = [];
          let curr = game.history.current();
          while(curr.move) {
            moves.push(ChessHelper.moveToCoordinateString(curr.move));            
            curr = curr.prev;
          }
          game.mexamineMovelist = moves.reverse();
        }

        if(game.move !== 'none')
          session.send('back 999');
        session.send('for 999');
      }
    }

    if(!game.setupBoard && (game.isExamining() || ((game.isObserving() || game.isPlayingOnline()) && game.move !== 'none'))) {
      game.movelistRequested++;
      session.send('iset startpos 1'); // Show the initial board position before the moves list
      session.send(`moves ${game.id}`);
      session.send('iset startpos 0');
    }

    game.history.initMetatags();

    if(mexamineRequested)
      mexamineRequested = null;
  }

  if(game === games.focused) {
    showTab($('#pills-game-tab'));
    if(game.role !== Role.NONE)
      showStatusPanel();
  }

  if(!mainGame || game.id !== mainGame.partnerGameId)
    scrollToBoard(game);
}

function gameEnd(data: any) {
  const game = games.findGame(data.game_id);
  if(!game)
    return;

  // Set clock time to the time that the player resigns/aborts etc.
  game.history.updateClockTimes(game.history.last(), game.clock.getWhiteTime(), game.clock.getBlackTime());

  if(data.reason <= 4 && game.element.find('.player-status .name').text() === data.winner) {
    // player won
    game.element.find('.player-status').parent().css('--bs-card-cap-bg', 'var(--game-win-color)');
    game.element.find('.opponent-status').parent().css('--bs-card-cap-bg', 'var(--game-lose-color)');
    if (game === games.focused && settings.soundToggle) {
      Sounds.winSound.play();
    }
  } else if (data.reason <= 4 && game.element.find('.player-status .name').text() === data.loser) {
    // opponent won
    game.element.find('.player-status').parent().css('--bs-card-cap-bg', 'var(--game-lose-color)');
    game.element.find('.opponent-status').parent().css('--bs-card-cap-bg', 'var(--game-win-color)');
    if (game === games.focused && settings.soundToggle) {
      Sounds.loseSound.play();
    }
  } else {
    // tie
    game.element.find('.player-status').parent().css('--bs-card-cap-bg', 'var(--game-tie-color)');
    game.element.find('.opponent-status').parent().css('--bs-card-cap-bg', 'var(--game-tie-color)');
  }

  const status = data.message.replace(/Game \d+ /, '');
  showStatusMsg(game, status);

  if(game.isPlaying()) {
    let rematch = [], analyze = [];
    let useSessionSend = true;
    if(data.reason !== Reason.Disconnect && data.reason !== Reason.Adjourn && data.reason !== Reason.Abort) {
      if(game.role === Role.PLAYING_COMPUTER) {
        rematch = ['rematchComputer();', 'Rematch'];
        useSessionSend = false;
      }
      else if(game.element.find('.player-status .name').text() === session.getUser())
        rematch = [`sessionSend('rematch')`, 'Rematch']
    }
    if(data.reason !== Reason.Adjourn && data.reason !== Reason.Abort && game.history.length()) {
      analyze = ['analyze();', 'Analyze'];
    }
    Dialogs.showBoardDialog({type: 'Match Result', msg: data.message, btnFailure: rematch, btnSuccess: analyze, icons: false});
  }
  game.history.setMetatags({Result: data.score, Termination: data.reason});

  cleanupGame(game);
}

function handleOffers(offers: any[]) { 
  // Clear the lobby
  if(offers[0].type === 'sc')
    $('#lobby-table').html('');

  // Add seeks to the lobby
  const seeks = offers.filter((item) => item.type === 's');
  if(seeks.length && lobbyRequested) {
    seeks.forEach((item) => {
      if(!settings.lobbyShowComputersToggle && item.title === 'C')
        return;
      if(!settings.lobbyShowUnratedToggle && item.ratedUnrated === 'u')
        return;

      const lobbyEntryText = formatLobbyEntry(item);
      $('#lobby-table').append(
        `<button type="button" data-offer-id="${item.id}" class="btn btn-outline-secondary lobby-entry"` 
          + ` onclick="acceptSeek(${item.id});">${lobbyEntryText}</button>`);
    });

    if(lobbyScrolledToBottom) {
      const container = $('#lobby-table-container')[0];
      container.scrollTop = container.scrollHeight;
    }
  }

  // Add our own seeks and match requests to the top of the Play pairing pane
  const sentOffers = offers.filter((item) => item.type === 'sn'
    || (item.type === 'pt' && (item.subtype === 'partner' || item.subtype === 'match')));
  if(sentOffers.length) {
    sentOffers.forEach((item) => {
      if(!$(`.sent-offer[data-offer-id="${item.id}"]`).length) {
        if(matchRequested)
          matchRequested--;
        newSentOffers.push(item);
        if(item.adjourned)
          removeAdjournNotification(item.opponent);
      }
    });
    if(newSentOffers.length) {
      clearTimeout(showSentOffersTimer);
      showSentOffersTimer = setTimeout(() => {
        showSentOffers(newSentOffers);
        newSentOffers = [];
      }, 1000);
    }
    $('#pairing-pane-status').hide();
  }

  // Offers received from another player
  const otherOffers = offers.filter((item) => item.type === 'pf');
  otherOffers.forEach((item) => {
    let headerTitle = '', bodyTitle = '', bodyText = '', displayType = '';
    switch(item.subtype) {
      case 'match':
        displayType = 'notification';
        const time = !isNaN(item.initialTime) ? ` ${item.initialTime} ${item.increment}` : '';
        bodyText = `${item.ratedUnrated} ${item.category}${time}`;
        if(item.adjourned) {
          headerTitle = 'Resume Adjourned Game Request';
          removeAdjournNotification(item.opponent);
        }
        else
          headerTitle = 'Match Request';
        bodyTitle = `${item.opponent} (${item.opponentRating})${item.color ? ` [${item.color}]` : ''}`;
        $('.notification').each((index, element) => {
          const headerTextElement = $(element).find('.header-text');
          const bodyTextElement = $(element).find('.body-text');
          if(headerTextElement.text() === 'Match Request' && bodyTextElement.text().startsWith(`${item.opponent}(`)) {
            $(element).attr('data-offer-id', item.id);
            bodyTextElement.text(`${bodyTitle} ${bodyText}`);
            const btnSuccess = $(element).find('.button-success');
            const btnFailure = $(element).find('.button-failure');
            btnSuccess.attr('onclick', `sessionSend('accept ${item.id}');`);
            btnFailure.attr('onclick', `sessionSend('decline ${item.id}');`);
            displayType = '';
          }
        });
        break;
      case 'partner':
        displayType = 'notification';
        headerTitle = 'Partnership Request';
        bodyTitle = item.toFrom;
        bodyText = 'offers to be your bughouse partner.';
        break;
      case 'takeback':
        displayType = 'dialog';
        headerTitle = 'Takeback Request';
        bodyTitle = item.toFrom;
        bodyText = `would like to take back ${item.parameters} half move(s).`;
        break;
      case 'abort':
        displayType = 'dialog';
        headerTitle = 'Abort Request';
        bodyTitle = item.toFrom;
        bodyText = 'would like to abort the game.';
        break;
      case 'draw':
        displayType = 'dialog';
        headerTitle = 'Draw Request';
        bodyTitle = item.toFrom;
        bodyText = 'offers you a draw.';
        break;
      case 'adjourn':
        displayType = 'dialog';
        headerTitle = 'Adjourn Request';
        bodyTitle = item.toFrom;
        bodyText = 'would like to adjourn the game.';
        break;
    }

    if(displayType) {
      let dialog: JQuery<HTMLElement>;
      if(displayType === 'notification')
        dialog = Dialogs.createNotification({type: headerTitle, title: bodyTitle, msg: bodyText, btnFailure: [`decline ${item.id}`, 'Decline'], btnSuccess: [`accept ${item.id}`, 'Accept'], useSessionSend: true});
      else if(displayType === 'dialog')
        dialog = Dialogs.showBoardDialog({type: headerTitle, title: bodyTitle, msg: bodyText, btnFailure: [`decline ${item.id}`, 'Decline'], btnSuccess: [`accept ${item.id}`, 'Accept'], useSessionSend: true});
      dialog.attr('data-offer-id', item.id);
    }
  });

  // Remove match requests and seeks. Note our own seeks are removed in the MessageType.Unknown section
  // since <sr> info is only received when we are in the lobby.
  const removals = offers.filter((item) => item.type === 'pr' || item.type === 'sr');
  removals.forEach((item) => {
    item.ids.forEach((id) => {
      Dialogs.removeNotification($(`.notification[data-offer-id="${id}"]`)); // If match request was not ours, remove the Notification
      $(`.board-dialog[data-offer-id="${id}"]`).toast('hide'); // if in-game request, hide the dialog
      $(`.sent-offer[data-offer-id="${id}"]`).remove(); // If offer, match request or seek was sent by us, remove it from the Play pane
      $(`.lobby-entry[data-offer-id="${id}"]`).remove(); // Remove seek from lobby
    });
    if(!$('#sent-offers-status').children().length)
      $('#sent-offers-status').hide();
  });
}

function showSentOffers(offers: any) {
  let requestsHtml = '';
  offers.forEach((offer) => {
    requestsHtml += `<div class="sent-offer" data-offer-type="${offer.type}" data-offer-id="${offer.id}">`;
    requestsHtml += `<span class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></span>&nbsp;&nbsp;`;

    let removeCmd: string;
    if(offer.type === 'pt') {
      if(offer.subtype === 'partner') {
        requestsHtml += `Making a partnership offer to ${offer.toFrom}.`;
        removeCmd = `withdraw ${offer.id}`;
      }
      else if(offer.subtype === 'match') {
        // convert match offers to the same format as seeks
        let color = '';
        if(offer.color === 'black')
          color = ' B';
        else if(offer.color === 'white')
          color = ' W';

        // Display 'u' if we are a registered user playing an unrated game.
        const unrated = session.isRegistered() && offer.ratedUnrated === 'unrated' && offer.category !== 'untimed' ? 'u' : '';
        const time = offer.category !== 'untimed' ? `${offer.initialTime} ${offer.increment} ` : '';

        const adjourned = (offer.adjourned ? ' (adjourned)' : '');

        requestsHtml += `Challenging ${offer.opponent} to ${time === '' ? 'an ' : 'a '}` 
          + `${time}${unrated}${offer.category}${color} game${adjourned}.`;
        removeCmd = `withdraw ${offer.id}`;
      }
    }
    else if(offer.type === 'sn') {
      // Display 'u' if we are a registered user playing an unrated game.
      const unrated = session.isRegistered() && offer.ratedUnrated === 'u' && offer.category !== 'untimed' ? 'u' : '';
      // Change 0 0 to 'untimed'
      const time = offer.category !== 'untimed' ? `${offer.initialTime} ${offer.increment} ` : '';
      const color = (offer.color !== '?' ? offer.color : '');

      requestsHtml += `Seeking ${time === '' ? 'an ' : 'a '}${time}${unrated}${offer.category}${color} game.`;
      removeCmd = `unseek ${offer.id}`;
    }

    const lastIndex = requestsHtml.lastIndexOf(' ') + 1;
    const lastWord = requestsHtml.slice(lastIndex);
    requestsHtml = requestsHtml.substring(0, lastIndex);
    requestsHtml += `<span style="white-space: nowrap">${lastWord}<span class="fa fa-times-circle btn btn-default `  
      + `btn-sm" onclick="sessionSend('${removeCmd}')" aria-hidden="false"></span></span></div>`;
  });

  $('#sent-offers-status').append(requestsHtml);
  $('#sent-offers-status').show();
  $('#play-pane-subcontent')[0].scrollTop = 0;
}

/**
 * Remove an adjourned game notification if the players are already attempting to resume their match
 */
function removeAdjournNotification(opponent: string) {
  const n1 = $(`.notification[data-adjourned-arrived="${opponent}"]`);
  Dialogs.removeNotification(n1);

  const n2 = $(`.notification[data-adjourned-list="true"]`);
  if(n2.length) {
    const bodyTextElement = n2.find('.body-text');
    const bodyText = bodyTextElement.html();
    const match = bodyText.match(/^\d+( players?, who (?:has|have) an adjourned game with you, (?:is|are) online:<br>)(.*)/);
    if(match && match.length > 2) {
      const msg = match[1];
      let players = match[2].trim().split(/\s+/);
      players = players.filter(item => item !== opponent);
      if(!players.length)
        Dialogs.removeNotification(n2);
      else
        bodyTextElement.html(`${players.length}${msg}${players.join(' ')}`);
    }
  }
}

function handleMiscMessage(data: any) {
  let msg = data.message;

  let match = msg.match(/^No one is observing game (\d+)\./m);
  if(match != null && match.length > 1) {
    if(allobsRequested) {
      allobsRequested--;
      return;
    }
    chat.newMessage('console', data);
    return;
  }

  match = msg.match(/^(?:Observing|Examining)\s+(\d+) [\(\[].+[\)\]]: (.+) \(\d+ users?\)/m);
  if (match != null && match.length > 1) {
    if (allobsRequested) {
      allobsRequested--;
      const game = games.findGame(+match[1]);
      if(!game)
        return;

      game.statusElement.find('.game-watchers').empty();
      match[2] = match[2].replace(/\(U\)/g, '');
      const watchers = match[2].split(' ');
      game.watchers = watchers.filter(item => item.replace('#', '') !== session.getUser());
      const chatTab = chat.getTabFromGameID(game.id);
      if(chatTab)
        chat.updateNumWatchers(chatTab);
      let req = '';
      let numWatchers = 0;
      for (let i = 0; i < watchers.length; i++) {
        if(watchers[i].replace('#', '') === session.getUser())
          continue;
        numWatchers++;
        if(numWatchers == 1)
          req = 'Watchers:';
        req += `<span class="ms-1 badge rounded-pill bg-secondary noselect">${watchers[i]}</span>`;
        if(numWatchers > 5) {
          req += ` + ${watchers.length - i} more.`;
          break;
        }
      }
      game.statusElement.find('.game-watchers').html(req);
      return;
    }
    chat.newMessage('console', data);
    return;
  }

  match = msg.match(/(?:^|\n)\s*\d+\s+(\(Exam\.\s+)?[0-9\+]+\s\w+\s+[0-9\+]+\s\w+\s*(\)\s+)?\[[\w\s]+\]\s+[\d:]+\s*\-\s*[\d:]+\s\(\s*\d+\-\s*\d+\)\s+[BW]:\s+\d+\s*\d+ games displayed/);
  if(match != null && match.length > 0 && gamesRequested) {
    showGames(msg);
    gamesRequested = false;
    return;
  }

  match = msg.match(/^Game (\d+): (\S+) has lagged for 30 seconds\./m);
  if(match) {
    const game = games.findGame(+match[1]);
    if(game && game.isPlaying()) {
      const bodyText = `${match[2]} has lagged for 30 seconds.<br>You may courtesy adjourn the game.<br><br>If you believe your opponent has intentionally disconnected, you can request adjudication of an adjourned game. Type 'help adjudication' in the console for more info.`;
      const dialog = Dialogs.showBoardDialog({type: 'Opponent Lagging', msg: bodyText, btnFailure: ['', 'Wait'], btnSuccess: ['adjourn', 'Adjourn'], useSessionSend: true});
      dialog.attr('data-game-id', game.id);
    }
    chat.newMessage('console', data);
    return;
  }

  match = msg.match(/^History for (\w+):.*/m);
  if(match != null && match.length > 1) {
    if(historyRequested) {
      historyRequested--;
      if(!historyRequested) {
        $('#history-username').val(match[1]);
        showHistory(match[1], data.message);
      }
    }
    else
      chat.newMessage('console', data);

    return;
  }

  // Retrieve status/error messages from commands sent to the server via the left menus
  match = msg.match(/^There is no player matching the name \w+\./m);
  if(!match)
    match = msg.match(/^\S+ is not a valid handle\./m);
  if(!match)
    match = msg.match(/^\w+ has no history games\./m);
  if(!match)
    match = msg.match(/^You need to specify at least two characters of the name\./m);
  if(!match)
    match = msg.match(/^Ambiguous name (\w+):/m);
  if(!match)
    match = msg.match(/^\w+ is not logged in\./m);
  if(!match)
    match = msg.match(/^\w+ is not playing a game\./m);
  if(!match)
    match = msg.match(/^Sorry, game \d+ is a private game\./m);
  if(!match)
    match = msg.match(/^\w+ is playing a game\./m);
  if(!match)
    match = msg.match(/^\w+ is examining a game\./m);
  if(!match)
    match = msg.match(/^You can't match yourself\./m);
  if(!match)
    match = msg.match(/^You cannot challenge while you are (?:examining|playing) a game\./m);
  if(!match)
    match = msg.match(/^You are already offering an identical match to \w+\./m);
  if(!match)
    match = msg.match(/^You can only have 3 active seeks\./m);
  if(!match)
    match = msg.match(/^There is no such game\./m);
  if(!match)
    match = msg.match(/^You cannot seek bughouse games\./m);
  if(!match)
    match = msg.match(/^\w+ is not open for bughouse\./m);
  if(!match)
    match = msg.match(/^Your opponent has no partner for bughouse\./m);
  if(!match)
    match = msg.match(/^You have no partner for bughouse\./m);
  if(match && (historyRequested || obsRequested || matchRequested || allobsRequested)) {
    let status: JQuery<HTMLElement>;
    if(historyRequested)
      status = $('#history-pane-status');
    else if(obsRequested)
      status = $('#observe-pane-status');
    else if(matchRequested)
      status = $('#pairing-pane-status');

    if(historyRequested) {
      historyRequested--;
      if(historyRequested)
        return;

      $('#history-table').html('');
    }
    else if(obsRequested) {
      obsRequested--;
      if(obsRequested)
        return;
    }
    else if(matchRequested)
      matchRequested--;
    else if(allobsRequested && match[0] === 'There is no such game.')
      allobsRequested--;

    if(status) {
      if(match[0].startsWith('Ambiguous name'))
        status.text(`There is no player matching the name ${match[1]}.`);
      else if(match[0].includes('is not open for bughouse.'))
        status.text(`${match[0]} Ask them to 'set bugopen 1' in the Console.`);
      else if(match[0] === 'You cannot seek bughouse games.')
        status.text('You must specify an opponent for bughouse.');
      else if(match[0].includes('no partner for bughouse.'))
        status.text(`${match[0]} Get one by using 'partner <username>' in the Console.`);
      else
        status.text(match[0]);

      status.show();
    }
    return;
  }

  match = msg.match(/(?:^|\n)(\d+ players?, who (?:has|have) an adjourned game with you, (?:is|are) online:)\n(.*)/);
  if(match && match.length > 2) {
    const n = Dialogs.createNotification({type: 'Resume Game', title: `${match[1]}<br>${match[2]}`, btnSuccess: ['resume', 'Resume Game'], useSessionSend: true});
    n.attr('data-adjourned-list', "true");
    chat.newMessage('console', data);
    return;
  }
  match = msg.match(/^Notification: ((\S+), who has an adjourned game with you, has arrived\.)/m);
  if(match && match.length > 2) {
    if(!$(`.notification[data-adjourned-arrived="${match[2]}"]`).length) {
      const n = Dialogs.createNotification({type: 'Resume Game', title: match[1], btnSuccess: [`resume ${match[2]}`, 'Resume Game'], useSessionSend: true});
      n.attr('data-adjourned-arrived', match[2]);
    }
    return;
  }
  match = msg.match(/^\w+ is not logged in./m);
  if(!match)
    match = msg.match(/^Player [a-zA-Z\"]+ is censoring you./m);
  if(!match)
    match = msg.match(/^Sorry the message is too long./m);
  if(!match)
    match = msg.match(/^You are muted./m);
  if(!match)
    match = msg.match(/^Only registered players may whisper to others' games./m);
  if(!match)
    match = msg.match(/^Notification: .*/m);
  if(match && match.length > 0) {
    chat.newNotification(match[0]);
    return;
  }

  // A match request sent to a player was declined or the player left
  match = msg.match(/^(\w+ declines the match offer\.)/m);
  if(!match)
    match = msg.match(/^(\w+, whom you were challenging, has departed\.)/m);
  if(match && match.length > 1) {
    $('#pairing-pane-status').show();
    $('#pairing-pane-status').text(match[1]);
  }

  match = msg.match(/^(\w+ declines the partnership request\.)/m);
  if(match && match.length > 1) {
    const headerTitle = 'Partnership Declined';
    const bodyTitle = match[1];
    Dialogs.createNotification({type: headerTitle, title: bodyTitle, useSessionSend: true});
  }
  match = msg.match(/^(\w+ agrees to be your partner\.)/m);
  if(match && match.length > 1) {
    const headerTitle = 'Partnership Accepted';
    const bodyTitle = match[1];
    Dialogs.createNotification({type: headerTitle, title: bodyTitle, useSessionSend: true});
  }

  match = msg.match(/^You are now observing game \d+\./m);
  if(match) {
    if(obsRequested) {
      obsRequested--;
      $('#observe-pane-status').hide();
      return;
    }

    chat.newMessage('console', data);
    return;
  }

  match = msg.match(/^(Issuing match request since the seek was set to manual\.)/m);
  if(match && match.length > 1 && lobbyRequested) {
    $('#lobby-pane-status').text(match[1]);
    $('#lobby-pane-status').show();
  }

  match = msg.match(/^Your seek has been posted with index \d+\./m);
  if(match) {
    // retrieve <sn> notification
    session.send('iset showownseek 1');
    session.send('iset seekinfo 1');
    session.send('iset seekinfo 0');
    session.send('iset showownseek 0');
    return;
  }

  match = msg.match(/^Your seeks have been removed\./m);
  if(!match)
    match = msg.match(/^Your seek (\d+) has been removed\./m);
  if(match) {
    if(match.length > 1) // delete seek by id
      $(`.sent-offer[data-offer-id="${match[1]}"]`).remove();
    else  // Remove all seeks
      $('.sent-offer[data-offer-type="sn"]').remove();

    if(!$('#sent-offers-status').children().length)
      $('#sent-offers-status').hide();
    return;
  }

  match = msg.match(/(?:^|\n)\s*Movelist for game (\d+):\s+(\S+) \((\d+|UNR)\) vs\. (\S+) \((\d+|UNR)\)[^\n]+\s+(\w+) (\S+) match, initial time: (\d+) minutes, increment: (\d+) seconds\./);
  if (match != null && match.length > 9) {
    const game = games.findGame(+match[1]);
    if(game && (game.movelistRequested || game.gameStatusRequested)) {
      if(game.isExamining()) {
        const id = match[1];
        const wname = match[2];
        let wrating = game.wrating = match[3];
        const bname = match[4];
        let brating = game.brating = match[5];
        const rated = match[6].toLowerCase();
        game.category = match[7];
        const initialTime = match[8];
        const increment = match[9];

        if(wrating === 'UNR') {
          game.wrating = '';
          match = wname.match(/Guest[A-Z]{4}/);
          if(match)
            wrating = '++++';
          else wrating = '----';
        }
        if(brating === 'UNR') {
          game.brating = '';
          match = bname.match(/Guest[A-Z]{4}/);
          if(match)
            brating = '++++';
          else brating = '----';
        }

        game.element.find('.player-status .rating').text(game.color === 'b' ? game.brating : game.wrating);
        game.element.find('.opponent-status .rating').text(game.color === 'b' ? game.wrating : game.brating);

        const time = initialTime === '0' && increment === '0' ? '' : ` ${initialTime} ${increment}`;

        const statusMsg = `<span class="game-id">Game ${id}: </span>${wname} (${wrating}) ${bname} (${brating}) `
          + `${rated} ${game.category}${time}`;
        showStatusMsg(game, statusMsg);

        const tags = game.history.metatags;
        game.history.setMetatags({
          ...(!('WhiteElo' in tags) && { WhiteElo: game.wrating || '-' }),
          ...(!('BlackElo' in tags) && { BlackElo: game.brating || '-' }),
          ...(!('Variant' in tags) && { Variant: game.category })
        });
        const chatTab = chat.getTabFromGameID(game.id);
        if(chatTab)
          chat.updateGameDescription(chatTab);
        initAnalysis(game);
        initGameTools(game);
      }

      game.gameStatusRequested = false;
      if(game.movelistRequested) {
        game.movelistRequested--;
        var categorySupported = SupportedCategories.includes(game.category);
        if(categorySupported)
          parseMovelist(game, msg);

        if(game.isExamining()) {
          if(game.history.length() || !categorySupported)
            session.send('back 999');
          if(!game.history.length || !categorySupported)
            game.history.scratch(true);

          if(game.mexamineMovelist) { // Restore current move after retrieving move list in mexamine mode
            if(categorySupported) {
              let curr = game.history.first().next;
              let forwardNum = 0;
              for(let move of game.mexamineMovelist) {
                if(curr && ChessHelper.moveToCoordinateString(curr.move) === move) {
                  forwardNum++;
                  curr = curr.next;
                }
                else {
                  curr = null;
                  if(forwardNum) {
                    session.send(`forward ${forwardNum}`);
                    forwardNum = 0;
                  }
                  session.send(move);
                }
              }
              if(forwardNum)
                session.send(`forward ${forwardNum}`);
            }
            game.mexamineMovelist = null;
          }
        }
        else
          game.history.display();
      }
      updateBoard(game, false, false);
      return;
    }
    else {
      chat.newMessage('console', data);
      return;
    }
  }

  match = msg.match(/^Your partner is playing game (\d+)/m);
  if (match != null && match.length > 1) {
    if(settings.multiboardToggle)
      session.send('pobserve');

    partnerGameId = +match[1];
    const mainGame = games.getPlayingExaminingGame();
    if(mainGame) {
      mainGame.partnerGameId = partnerGameId;
      chat.createTab(`Game ${mainGame.id} and ${partnerGameId}`);
    }
  }

  match = msg.match(/^(Creating|Game\s(\d+)): (\S+) \(([\d\+\-\s]+)\) (\S+) \(([\d\-\+\s]+)\) \S+ (\S+).+/m);
  if(match != null && match.length > 7) {
    let game: Game;
    if(!settings.multiboardToggle)
      game = games.getMainGame();
    else {
      game = games.findGame(+match[2]);
      if(!game)
        game = games.getFreeGame();
      if(!game)
        game = createGame();
    }

    if(settings.multiboardToggle || !game.isPlaying() || +match[2] === game.id) {
      game.wrating = (isNaN(match[4]) || match[4] === '0') ? '' : match[4];
      game.brating = (isNaN(match[6]) || match[6] === '0') ? '' : match[6];
      game.category = match[7];

      let status = match[0].substring(match[0].indexOf(':') + 1);
      if(game.role !== Role.NONE)
        status = `<span class="game-id">Game ${game.id}: </span>${status}`;
      showStatusMsg(game, status);

      if(game.history)
        game.history.initMetatags();

      if(match[3] === session.getUser() || match[1].startsWith('Game')) {
        game.element.find('.player-status .rating').text(game.wrating);
        game.element.find('.opponent-status .rating').text(game.brating);
      } 
      else if(match[5] === session.getUser()) {
        game.element.find('.opponent-status .rating').text(game.wrating);
        game.element.find('.player-status .rating').text(game.brating);
      }
    }
    data.message = msg = Utils.removeLine(msg, match[0]); // remove the matching line
    if(!msg)
      return;
  }

  /* Parse score and termination reason for examined games */
  match = msg.match(/^Game (\d+): ([a-zA-Z]+)(?:' game|'s)?\s([^\d\*]+)\s([012/]+-[012/]+)/m);
  if(match != null && match.length > 3) {
    const game = games.findGame(+match[1]);
    if(game && game.history) {
      const who = match[2];
      const action = match[3];
      const score = match[4];
      const [winner, loser, reason] = session.getParser().getGameResult(game.wname, game.bname, who, action);
      game.history.setMetatags({Result: score, Termination: reason});
      return;
    }
  }

  match = msg.match(/^Removing game (\d+) from observation list./m);
  if(!match)
    match = msg.match(/^You are no longer examining game (\d+)./m);
  if(match != null && match.length > 1) {
    const game = games.findGame(+match[1]);
    if(game) {
      mexamineGame = game; // Stores the game in case a 'mexamine' is about to be issued.
      if(game === games.focused)
        stopEngine();
      cleanupGame(game);
    }

    const index = gameExitPending.indexOf(+match[1]);
    if(index !== -1) {
      gameExitPending.splice(index, 1);
      if(!gameExitPending.length && !settings.multiboardToggle)
        session.send('refresh');
    }
    return;
  }

  match = msg.match(/(?:^|\n)-- channel list: \d+ channels --\s*([\d\s]*)/);
  if(match !== null && match.length > 1) {
    if(!channelListRequested)
      chat.newMessage('console', data);

    channelListRequested = false;
    return chat.addChannels(match[1].split(/\s+/).sort(function(a, b) { return a - b; }));
  }

  match = msg.match(/(?:^|\n)-- computer list: \d+ names --([\w\s]*)/);
  if(match !== null && match.length > 1) {
    if(!computerListRequested)
      chat.newMessage('console', data);

    computerListRequested = false;
    computerList = match[1].split(/\s+/);
    return;
  }

  match = msg.match(/^\[\d+\] (?:added to|removed from) your channel list\./m);
  if(match != null && match.length > 0) {
    session.send('=ch');
    channelListRequested = true;
    chat.newMessage('console', data);
    return;
  }

  // Suppress messages when 'moves' command issued internally
  match = msg.match(/^You're at the (?:beginning|end) of the game\./m);
  if(match) {
    for(let game of games) {
      if(game.movelistRequested) {
        return;
      }
    }
  }

  // Enter setup mode when server (other user or us) issues 'bsetup' command
  match = msg.match(/^Entering setup mode\./m);
  if(!match)
    match = msg.match(/^Game (\d+): \w+ enters setup mode\./m);
  if(match) {
    const game = match.length > 1 ? games.findGame(+match[1]) : games.getPlayingExaminingGame();
    if(game) {
      if(!game.commitingMovelist && !game.setupBoard)
        setupBoard(game, true);
    }
    else
      setupBoardPending = true; // user issued 'bsetup' before 'examine'
  }
  // Leave setup mode when server (other user or us) issues 'bsetup done' command
  match = msg.match(/^Game is validated - entering examine mode\./m);
  if(!match)
    match = msg.match(/^Game (\d+): \w+ has validated the position. Entering examine mode\./m);
  if(match) {
    const game = match.length > 1 ? games.findGame(+match[1]) : games.getPlayingExaminingGame();
    if(game && !game.commitingMovelist && game.setupBoard)
      leaveSetupBoard(game, true);
  }

  // Suppress output when commiting a movelist in examine mode
  match = msg.match(/^Game \d+: \w+ commits the subvariation\./m);
  if(!match)
    match = msg.match(/^Game \d+: \w+ sets (white|black)'s clock to \S+/m);
  if(!match)
    match = msg.match(/^Game \d+: \w+ moves: \S+/m);
  if(!match)
    match = msg.match(/^Entering setup mode\./m);
  if(!match)
    match = msg.match(/^Castling rights for (white|black) set to \w+\./m);
  if(!match)
    match = msg.match(/^It is now (white|black)'s turn to move\./m);
  if(!match)
    match = msg.match(/^Game is validated - entering examine mode\./m);
  if(!match)
    match = msg.match(/^The game type is now .*/m);
  if(!match)
    match = msg.match(/^done: Command not found\./m);
  if(match) {
    const game = games.getPlayingExaminingGame();
    if(game && game.commitingMovelist) {
      if(match[0] === 'done: Command not found.') // This was sent by us to indicate when we are done
        game.commitingMovelist = false;
      return;
    }
  }

  // Support for multiple examiners, we need to handle other users commiting or truncating moves from the main line
  match = msg.match(/^Game (\d+): \w+ commits the subvariation\./m);
  if(match) {
    const game = games.findGame(+match[1]);
    if(game) {
      // An examiner has commited the current move to the mainline. So we need to also make it the mainline.
      game.history.scratch(false);
      const curr = game.history.current();
      while(curr.depth() > 0)
        game.history.promoteSubvariation(curr);
      // Make the moves following the commited move a continuation (i.e. not mainline)
      if(curr.next)
        game.history.makeContinuation(curr.next);
    }
  }
  match = msg.match(/^Game (\d+): \w+ truncates the game at halfmove (\d+)\./m);
  if(match) {
    const game = games.findGame(+match[1]);
    if(game) {
      const index = +match[2];
      if(index === 0)
        game.history.scratch(true); // The entire movelist was truncated so revert back to being a scratch game
      else {
        const entry = game.history.getByIndex(index)
        if(entry && entry.next)
          game.history.makeContinuation(entry.next);
      }
    }
  }

  match = msg.match(/^\w+ has made you an examiner of game \d+\./m);
  if(match) {
    mexamineRequested = mexamineGame;
    return;
  }

  match = msg.match(/^Starting a game in examine \(scratch\) mode\./m);
  if(match && examineModeRequested)
    return;

  match = msg.match(/^Game\s\d+: \w+ backs up \d+ moves?\./m);
  if(!match)
    match = msg.match(/^Game\s\d+: \w+ goes forward \d+ moves?\./m);
  if(match)
    return;

  if (
    msg === 'Style 12 set.' ||
    msg === 'You will not see seek ads.' ||
    msg === 'You will now hear communications echoed.' ||
    msg === 'seekinfo set.' || msg === 'seekinfo unset.' ||
    msg === 'seekremove set.' || msg === 'seekremove unset.' ||
    msg === 'defprompt set.' ||
    msg === 'nowrap set.' ||
    msg === 'startpos set.' || msg === 'startpos unset.' ||
    msg === 'showownseek set.' || msg === 'showownseek unset.' ||
    msg === 'pendinfo set.' ||
    msg === 'ms set.' ||
    msg.startsWith('<12>') // Discard malformed style 12 messages (sometimes the server sends them split in two etc).
  ) {
    return;
  }

  chat.newMessage('console', data);
}

export function cleanup() {
  partnerGameId = null;
  historyRequested = 0;
  obsRequested = 0;
  allobsRequested = 0;
  gamesRequested = false;
  lobbyRequested = false;
  channelListRequested = false;
  computerListRequested = false;
  setupBoardPending = false;
  examineModeRequested = null;
  mexamineRequested = null;
  gameExitPending = [];
  clearMatchRequests();
  Dialogs.clearNotifications();
  for(const game of games) {
    if(game.role !== Role.PLAYING_COMPUTER)
      cleanupGame(game);
  }
}

export function disableOnlineInputs(disable: boolean) {
  $('#pills-pairing *').prop('disabled', disable);
  $('#pills-lobby *').prop('disabled', disable);
  $('#quick-game').prop('disabled', disable);
  $('#pills-history *').prop('disabled', disable);
  $('#pills-observe *').prop('disabled', disable);
  $('#chan-dropdown *').prop('disabled', disable);
  $('#input-form *').prop('disabled', disable);
}

/**********************************************************
 * GAME BOARD PANEL FUNCTIONS                             *
 * Including player/opponent status panels and game board *
 **********************************************************/

/** PLAYER/OPPONENT STATUS PANEL FUNCTIONS **/

function setFontSizes() {
  setTimeout(() => {
    // Resize fonts for player and opponent name to fit
    $('.status').each((index, element) => {
      const nameElement = $(element).find('.name');
      const ratingElement = $(element).find('.rating');
      const nameRatingElement = $(element).find('.name-rating');

      nameElement.css('font-size', '');
      ratingElement.css('width', '');

      const nameBorderWidth = nameElement.outerWidth() - nameElement.width();
      const nameMaxWidth = nameRatingElement.width() - ratingElement.outerWidth() - nameBorderWidth;
      const fontSize = calculateFontSize(nameElement, nameMaxWidth);
      nameElement.css('font-size', `${fontSize}px`);

      // Hide rating badge if partially clipped
      if(nameElement.outerWidth() + ratingElement.outerWidth() > nameRatingElement.width()) {
        ratingElement.width(0);
        ratingElement.css('visibility', 'hidden');
      }
      else
        ratingElement.css('visibility', 'visible');
    });
  });
}

function showCapturedMaterial(game: Game) {
  let whiteChanged = false, blackChanged = false;

  let captured = {
    P: 0, R: 0, B: 0, N: 0, Q: 0, K: 0, p: 0, r: 0, b: 0, n: 0, q: 0, k: 0
  };

  if(game.category === 'crazyhouse' || game.category === 'bughouse')
    captured = game.history.current().variantData.holdings; // for crazyhouse/bughouse we display the actual pieces captured
  else {
    const material = {
      P: 0, R: 0, B: 0, N: 0, Q: 0, K: 0, p: 0, r: 0, b: 0, n: 0, q: 0, k: 0
    };

    const pos = game.history.current().fen.split(/\s+/)[0];
    for(let i = 0; i < pos.length; i++) {
      if(material.hasOwnProperty(pos[i]))
        material[pos[i]]++;
    }

    // Get material difference between white and black, represented as "captured pieces"
    // e.g. if black is 2 pawns up on white, then 'captured' will contain P: 2 (two white pawns).
    const pieces = Object.keys(material).filter(key => key === key.toUpperCase());
    for(const whitePiece of pieces) {
      const blackPiece = whitePiece.toLowerCase();
      if(material[whitePiece] > material[blackPiece]) {
        captured[blackPiece] = material[whitePiece] - material[blackPiece];
        captured[whitePiece] = 0;
      }
      else {
        captured[whitePiece] = material[blackPiece] - material[whitePiece];
        captured[blackPiece] = 0;
      }
    }
  }

  if(game.captured !== undefined) {
    for(let key in captured) {
      if(game.captured[key] != captured[key]) {
        if(key === key.toUpperCase())
          blackChanged = true;
        else
          whiteChanged = true;
      }
    }
  }
  game.captured = captured;

  if(whiteChanged) {
    const panel = (game.color === 'w' ? game.element.find('.player-status .captured') : game.element.find('.opponent-status .captured'));
    panel.empty();
  }
  if(blackChanged) {
    const panel = (game.color === 'b' ? game.element.find('.player-status .captured') : game.element.find('.opponent-status .captured'));
    panel.empty();
  }

  for(const key in captured) {
    let num: number, color: string, piece: string, draggedPiece: string, panel: JQuery<HTMLElement>;
    if(whiteChanged && key === key.toLowerCase() && captured[key] > 0) {
      color = 'b';
      piece = `${color}${key.toUpperCase()}`;
      draggedPiece = `w${key}`;
      num = captured[key];
      panel = (game.color === 'w' ? game.element.find('.player-status .captured') : game.element.find('.opponent-status .captured'));
    }
    else if(blackChanged && key === key.toUpperCase() && captured[key] > 0) {
      color = 'w';
      piece = `${color}${key}`;
      draggedPiece = `b${key}`;
      num = captured[key];
      panel = (game.color === 'b' ? game.element.find('.player-status .captured') : game.element.find('.opponent-status .captured'));
    }
    if(panel) {
      var pieceElement = $(`<span class="captured-piece" data-drag-piece="${draggedPiece}"><img src="assets/css/images/pieces/merida/` 
        + `${piece}.svg"/><small>${num}</small></span>`);

      panel.append(pieceElement);

      if(game.category === 'crazyhouse' || game.category === 'bughouse') {
        pieceElement[0].addEventListener('touchstart', dragPiece, {passive: false});
        pieceElement[0].addEventListener('mousedown', dragPiece);
      }
    }
  }
}

function dragPiece(event: any) {
  const game = games.focused;
  const id = $(event.target).closest('[data-drag-piece]').attr('data-drag-piece');
  const color = id.charAt(0);
  const type = id.charAt(1);

  const cgRoles = {
    p: 'pawn',
    r: 'rook',
    n: 'knight',
    b: 'bishop',
    q: 'queen',
    k: 'king',
  };

  const piece = {
    role: cgRoles[type.toLowerCase()],
    color: (color === 'w' ? 'white' : 'black')
  };

  if((game.isPlaying() && game.color === color) || game.isExamining() || game.role === Role.NONE) {
    Utils.lockOverflow(); // Stop scrollbar appearing due to player dragging piece below the visible window
    game.board.dragNewPiece(piece, event);
    event.preventDefault();
  }
}

function setClocks(game: Game) {
  const hEntry = (game.isPlaying() || game.role === Role.OBSERVING ? game.history?.last() : game.history?.current());

  if(!game.isPlaying() && game.role !== Role.OBSERVING) {
    game.clock.setWhiteClock(hEntry.wtime);
    game.clock.setBlackClock(hEntry.btime);
  }

  // Add my-turn highlighting to clock
  const whiteClock = (game.color === 'w' ? game.element.find('.player-status .clock') : game.element.find('.opponent-status .clock'));
  const blackClock = (game.color === 'b' ? game.element.find('.player-status .clock') : game.element.find('.opponent-status .clock'));

  const turnColor = hEntry.turnColor;
  if(turnColor === 'b') {
    whiteClock.removeClass('my-turn');
    blackClock.addClass('my-turn');
  }
  else {
    blackClock.removeClass('my-turn');
    whiteClock.addClass('my-turn');
  }
}

// Start clock after a move, switch from white to black's clock etc
function hitClock(game: Game, setClocks: boolean = false) {
  if(game.isPlaying() || game.role === Role.OBSERVING) {
    const ply = game.history.last().ply;
    const turnColor = game.history.last().turnColor;

    // If a move was received from the server, set the clocks to the updated times
    // Note: When in examine mode this is handled by setClocks() instead
    if(setClocks) { // Get remaining time from server message
      if(game.category === 'untimed') {
        game.clock.setWhiteClock(null);
        game.clock.setBlackClock(null);
      }
      else {
        game.clock.setWhiteClock();
        game.clock.setBlackClock();
      }
    }
    else if(game.inc !== 0) { // Manually add time increment
      if(turnColor === 'w' && ply >= 5)
        game.clock.setBlackClock(game.clock.getBlackTime() + game.inc * 1000);
      else if(turnColor === 'b' && ply >= 4)
        game.clock.setWhiteClock(game.clock.getWhiteTime() + game.inc * 1000);
    }

    if((ply >= 3 || game.category === 'bughouse') && turnColor === 'w')
      game.clock.startWhiteClock();
    else if((ply >= 4 || game.category === 'bughouse') && turnColor === 'b')
      game.clock.startBlackClock();
  }
}

/** GAME BOARD FUNCTIONS **/

function createBoard(element: any): any {
  return Chessground(element[0], {
    movable: {
      events: {
        after: movePiece,
        afterNewPiece: movePiece,
      }
    },
    premovable: {
      events: {
        set: preMovePiece,
        unset: hidePromotionPanel,
      }
    },
    events: {
      change: boardChanged
    }
  });
}

export function updateBoard(game: Game, playSound: boolean = false, setBoard: boolean = true) {
  if(!game.history)
    return;

  const move = game.history.current().move;
  const fen = game.history.current().fen;
  const color = (ChessHelper.getTurnColorFromFEN(fen) === 'w' ? 'white' : 'black');

  setClocks(game);

  if(setBoard && !game.setupBoard)
    game.board.set({ fen });

  if(game.element.find('.promotion-panel').is(':visible')) {
    game.board.cancelPremove();
    hidePromotionPanel(game);
  }

  const categorySupported = SupportedCategories.includes(game.category);

  if(move && move.from && move.to)
    game.board.set({ lastMove: [move.from, move.to] });
  else if(move && move.to)
    game.board.set({ lastMove: [move.to] });
  else
    game.board.set({ lastMove: false });

  let dests: Map<string, string[]> | undefined;
  let movableColor: string | undefined;
  let turnColor: string | undefined;

  if(game.isObserving()) {
    turnColor = color;
  }
  else if(game.isPlaying()) {
    movableColor = (game.color === 'w' ? 'white' : 'black');
    dests = gameToDests(game);
    turnColor = color;
  }
  else if(game.setupBoard || (!categorySupported && game.role === Role.NONE)) {
    movableColor = 'both';
  }
  else {
    movableColor = color;
    dests = gameToDests(game);
    turnColor = color;
  }

  let movable: any = {};
  movable = {
    color: movableColor,
    dests,
    showDests: settings.highlightsToggle,
    rookCastle: game.category === 'wild/fr',
    free: game.setupBoard || !categorySupported
  };

  game.board.set({
    turnColor,
    movable,
    draggable: {
      deleteOnDropOff: game.setupBoard
    },
    highlight: {
      lastMove: settings.highlightsToggle,
      check: settings.highlightsToggle
    },
    predroppable: { enabled: game.category === 'crazyhouse' || game.category === 'bughouse' },
    check: !game.setupBoard && /[+#]/.test(move?.san) ? color : false,
    blockTouchScroll: (game.isPlaying() ? true : false),
    autoCastle: !game.setupBoard && (categorySupported || game.category === 'atomic')
  });

  showCapturedMaterial(game);
  showOpeningName(game);
  setFontSizes();

  if(playSound && settings.soundToggle && game === games.focused) {
    clearTimeout(soundTimer);
    soundTimer = setTimeout(() => {
      if(/[+#]/.test(move?.san)) {
        Sounds.checkSound.pause();
        Sounds.checkSound.currentTime = 0;
        Sounds.checkSound.play();
      }
      else if(move?.san.includes('x')) {
        Sounds.captureSound.pause();
        Sounds.captureSound.currentTime = 0;
        Sounds.captureSound.play();
      }
      else {
        Sounds.moveSound.pause();
        Sounds.moveSound.currentTime = 0;
        Sounds.moveSound.play();
      }
    }, 50);
  }

  if(game === games.focused) {
    if(game.history.current().isSubvariation()) {
      $('#exit-subvariation').removeClass('disabled');
      $('#exit-subvariation').show();
    }
    else
      $('#exit-subvariation').addClass('disabled');
  }
}

function boardChanged() {
  const game = games.focused;
  if(game.setupBoard) {
    var fen = getSetupBoardFEN(game);

    if(ChessHelper.splitFEN(fen).board === ChessHelper.splitFEN(game.fen).board)
      return;

    if(game.isExamining())
      session.send(`bsetup fen ${game.board.getFen()}`);

    // Remove castling rights if king or rooks move from initial position
    const newFEN = ChessHelper.adjustCastlingRights(fen, game.fen, game.category);
    if(newFEN !== fen)
      setupBoardCastlingRights(game, ChessHelper.splitFEN(newFEN).castlingRights);

    game.fen = newFEN;
    updateEngine();
  }
}

/** 
 * Scroll to the game board which currently has focus 
 */ 
export function scrollToBoard(game?: Game) {
  if(Utils.isSmallWindow()) {
    if(!game || game.element.parent().attr('id') === 'main-board-area') {
      if($('#collapse-chat').hasClass('show')) {
        $('#collapse-chat').collapse('hide'); // this will scroll to board after hiding chat
        return;
      }
      const windowHeight = window.visualViewport ? window.visualViewport.height : $(window).height();
      Utils.safeScrollTo($('#right-panel-header').offset().top + $('#right-panel-header').outerHeight() - windowHeight);
    }
    else
      Utils.safeScrollTo(game.element.offset().top);
  }
}

export function movePiece(source: any, target: any, metadata: any) {
  const game = games.focused;

  if(game.isObserving())
    return;

  // Show 'Analyze' button once any moves have been made on the board
  showAnalyzeButton();

  if(game.setupBoard)
    return;

  const prevHEntry = currentGameMove(game);

  const cgRoles = {pawn: 'p', rook: 'r', knight: 'n', bishop: 'b', queen: 'q', king: 'k'};
  const pieces = game.board.state.pieces;
  const pieceRole = cgRoles[pieces.get(target).role];
  const pieceColor = pieces.get(target).color;

  let promotePiece = '';
  if(game.promotePiece)
    promotePiece = game.promotePiece;
  else if(pieceRole === 'p' && !cgRoles.hasOwnProperty(source) && target.charAt(1) === (pieceColor === 'white' ? '8' : '1'))
    promotePiece = 'q';

  const inMove = {
    from: (!cgRoles.hasOwnProperty(source) ? source : ''),
    to: target,
    promotion: promotePiece,
    piece: pieceRole,
  };

  const parsedMove = parseGameMove(game, prevHEntry.fen, inMove);
  const fen = parsedMove ? parsedMove.fen : null;
  const move = parsedMove ? parsedMove.move : inMove;

  if(!parsedMove && SupportedCategories.includes(game.category)) {
    updateBoard(game, false, true);
    return;
  }

  game.movePieceSource = source;
  game.movePieceTarget = target;
  game.movePieceMetadata = metadata;
  var nextMove = game.history.next();

  if(promotePiece && !game.promotePiece && !settings.autoPromoteToggle) {
    showPromotionPanel(game, false);
    game.board.set({ movable: { color: undefined } });
    return;
  }

  if(parsedMove) {
    if(game.history.editMode && game.newVariationMode === NewVariationMode.ASK && nextMove) {
      let subFound = false;
      for(let i = 0; i < nextMove.subvariations.length; i++) {
        if(nextMove.subvariations[i].fen === fen)
          subFound = true;
      }
      if(nextMove.fen !== fen && !subFound) {
        createNewVariationMenu(game);
        return;
      }
    }
  }

  if(game.isPlayingOnline() && prevHEntry.turnColor === game.color)
    sendMove(move);

  if(game.isExamining()) {
    let nextMoveMatches = false;
    if(nextMove
        && ((!move.from && !nextMove.from && move.piece === nextMove.piece) || move.from === nextMove.from)
        && move.to === nextMove.to
        && move.promotion === nextMove.promotion)
      nextMoveMatches = true;

    if(nextMoveMatches && !nextMove.isSubvariation && !game.history.scratch())
      session.send('for');
    else
      sendMove(move);
  }

  hitClock(game, false);

  game.wtime = game.clock.getWhiteTime();
  game.btime = game.clock.getBlackTime();

  game.promotePiece = null;
  if(parsedMove && parsedMove.move)
    movePieceAfter(game, move, fen);

  if(game.role === Role.PLAYING_COMPUTER) // Send move to engine in Play Computer mode
    getComputerMove(game);

  showTab($('#pills-game-tab'));
}

function movePieceAfter(game: Game, move: any, fen?: string) {
  // go to current position if user is looking at earlier move in the move list
  if((game.isPlaying() || game.isObserving()) && game.history.current() !== game.history.last())
    game.history.display(game.history.last());

  updateHistory(game, move, fen);

  game.board.playPremove();
  game.board.playPredrop(() => true);

  checkGameEnd(game); // Check whether game is over when playing against computer (offline mode)
}

function preMovePiece(source: any, target: any, metadata: any) {
  var game = games.focused;
  const cgRoles = {pawn: 'p', rook: 'r', knight: 'n', bishop: 'b', queen: 'q', king: 'k'};
  if(cgRoles.hasOwnProperty(source) || settings.autoPromoteToggle) // piece drop rather than move
    return;
  const pieces = game.board.state.pieces;
  const pieceRole = cgRoles[pieces.get(source).role];
  const pieceColor = pieces.get(source).color;
  if(pieceRole === 'p' && target.charAt(1) === (pieceColor === 'white' ? '8' : '1')) {
    game.movePieceSource = source;
    game.movePieceTarget = target;
    game.movePieceMetadata = metadata;    
    showPromotionPanel(game, true);
  }
}

function showPromotionPanel(game: Game, premove: boolean = false) {
  const source = game.movePieceSource;
  const target = game.movePieceTarget;
  const metadata = game.movePieceMetadata;
  const showKing = !SupportedCategories.includes(game.category) && game.category !== 'atomic';

  game.promoteIsPremove = premove;
  const orientation = game.board.state.orientation;
  const color = (target.charAt(1) === '8' ? 'white' : 'black');
  const fileNum = target.toLowerCase().charCodeAt(0) - 97;

  hidePromotionPanel(game);
  const promotionPanel = $(`<div class="cg-wrap promotion-panel"></div>`);
  promotionPanel.appendTo(game.element.find('.board-container'));
  promotionPanel.css({
    left: `calc(12.5% * ${orientation === "white" ? fileNum : 7 - fileNum})`,
    height: showKing ? '62.5%' : '50%',
    top: orientation === color ? '0' : '50%',
    display: 'flex'
  });
  if(orientation === color) {
    promotionPanel.html(`
      <piece data-piece="q" class="promotion-piece queen ${color}"></piece>
      <piece data-piece="n" class="promotion-piece knight ${color}"></piece>
      <piece data-piece="r" class="promotion-piece rook ${color}"></piece>
      <piece data-piece="b" class="promotion-piece bishop ${color}"></piece>
      ${showKing ? `<piece data-piece="k" class="promotion-piece king ${color}"></piece>` : ``}
    `);
  }
  else {
    promotionPanel.html(`
      ${showKing ? `<piece data-piece="k" class="promotion-piece king ${color}"></piece>` : ``}
      <piece data-piece="b" class="promotion-piece bishop ${color}"></piece>
      <piece data-piece="r" class="promotion-piece rook ${color}"></piece>
      <piece data-piece="n" class="promotion-piece knight ${color}"></piece>
      <piece data-piece="q" class="promotion-piece queen ${color}"></piece>
    `);
  }

  $('.promotion-piece').on('click', (event) => {
    hidePromotionPanel();
    games.focused.promotePiece = $(event.target).attr('data-piece');
    if(!premove)
      movePiece(source, target, metadata);
  });
}

function hidePromotionPanel(game?: Game) {
  if(!game)
    game = games.focused;

  game.promotePiece = null;
  game.element.find('.promotion-panel').remove();
}

/**
 * When in Edit Mode, if a move is made on the board, display a menu asking if the user wishes to
 * create a new variation or overwrite the existing variation.
 */
function createNewVariationMenu(game: Game) {
  var menu = $(`
    <ul class="context-menu dropdown-menu">
      <li><a class="dropdown-item noselect" data-action="overwrite">Overwrite variation</a></li>
      <li><a class="dropdown-item noselect" data-action="new">New variation</a></li>
    </ul>`);

  var closeMenuCallback = (event: any) => {
    updateBoard(game);
  }

  var itemSelectedCallback = (event: any) => {
    var action = $(event.target).data('action');
    if(action === 'new')
      game.newVariationMode = NewVariationMode.NEW_VARIATION;
    else
      game.newVariationMode = NewVariationMode.OVERWRITE_VARIATION;
    movePiece(game.movePieceSource, game.movePieceTarget, game.movePieceMetadata);
  }

  var x = lastPointerCoords.x;
  var y = (Utils.isSmallWindow() ? lastPointerCoords.y : lastPointerCoords.y + 15);

  Utils.createContextMenu(menu, x, y, itemSelectedCallback, closeMenuCallback, 'top', ['top-start', 'top-end', 'bottom-start', 'bottom-end']);
}

function flipBoard(game: Game) {
  game.board.toggleOrientation();

  // If pawn promotion dialog is open, redraw it in the correct location
  if(game.element.find('.promotion-panel').is(':visible'))
    showPromotionPanel(game, game.promoteIsPremove);

  // Swap player and opponent status panels
  if(game.element.find('.player-status').parent().hasClass('top-panel')) {
    game.element.find('.player-status').appendTo(game.element.find('.bottom-panel'));
    game.element.find('.opponent-status').appendTo(game.element.find('.top-panel'));
  }
  else {
    game.element.find('.player-status').appendTo(game.element.find('.top-panel'));
    game.element.find('.opponent-status').appendTo(game.element.find('.bottom-panel'));
  }
}

/**************************
 * MOVE PARSING FUNCTIONS *
 **************************/

/** Wrapper function for parseMove */
function parseGameMove(game: Game, fen: string, move: any) {
  return ChessHelper.parseMove(fen, move, game.history.first().fen, game.category, game.history.current().variantData);
}

/** Wrapper function for toDests */
function gameToDests(game: Game) {
  return ChessHelper.toDests(currentGameMove(game).fen, game.history.first().fen, game.category, game.history.current().variantData);
}

/** Wrapper function for updateVariantMoveData */
function updateGameVariantMoveData(game: Game) {
  game.history.current().variantData = ChessHelper.updateVariantMoveData(game.history.prev().fen, game.history.current().move, game.history.prev().variantData, game.category);
}

export function parseMovelist(game: Game, movelist: string) {
  const moves = [];
  let found : string[] & { index?: number } = [''];
  let n = 1;
  var wtime = game.time * 60000;
  var btime = game.time * 60000;

  // We've set 'iset startpos 1' so that the 'moves' command also returns the start position in style12 in cases
  // where the start position is non-standard, e.g. fischer random.
  var match = movelist.match(/^<12>.*/m);
  if(match) {
    // FICS sets the role parameter (my relation to this game) in the style12 to -4, which the parser
    // doesn't parse by default, since we want it to be parsed together with the movelist.
    // Change the role to -3 so it won't get ignored by the parser this time.
    let s = match[0].replace(/(<12> (\S+\s){18})([-\d]+)/, '$1-3');
    let startpos = session.getParser().parse(s);
    var chess = Chess(startpos.fen);
    game.history.setMetatags({SetUp: '1', FEN: startpos.fen});
  }
  else
    var chess = Chess();

  game.history.reset(chess.fen(), wtime, btime);
  while (found !== null) {
    found = movelist.match(new RegExp(n + '\\.\\s*(\\S*)\\s*\\((\\d+):(\\d+)\.(\\d+)\\)\\s*(?:(\\S*)\\s*\\((\\d+):(\\d+)\.(\\d+)\\))?.*', 'm'));
    if (found !== null && found.length > 4) {
      const m1 = found[1].trim();
      if(m1 !== '...') {
        wtime += (n === 1 ? 0 : game.inc * 1000) - (+found[2] * 60000 + +found[3] * 1000 + +found[4]);
        var parsedMove = parseGameMove(game, chess.fen(), m1);
        if(!parsedMove)
          break;
        chess.load(parsedMove.fen);
        game.history.add(parsedMove.move, parsedMove.fen, false, wtime, btime);
        getOpening(game);
        updateGameVariantMoveData(game);
      }
      if (found.length > 5 && found[5]) {
        const m2 = found[5].trim();
        btime += (n === 1 ? 0 : game.inc * 1000) - (+found[6] * 60000 + +found[7] * 1000 + +found[8]);
        parsedMove = parseGameMove(game, chess.fen(), m2);
        if(!parsedMove)
          break;
        chess.load(parsedMove.fen);
        game.history.add(parsedMove.move, parsedMove.fen, false, wtime, btime);
        getOpening(game);
        updateGameVariantMoveData(game);
      }
      n++;
    }
  }
}

function updateHistory(game: Game, move?: any, fen?: string) {
  // This is to allow multiple fast 'forward' or 'back' button presses in examine mode before the command reaches the server
  // bufferedHistoryEntry contains a temporary reference to the current move which is used for subsequent forward/back button presses
  if(game.bufferedHistoryCount)
    game.bufferedHistoryCount--;
  if(!game.bufferedHistoryCount)
    game.bufferedHistoryEntry = null;

  // If currently commiting a move list in examine mode. Don't display moves until we've finished
  // sending the move list and then navigated back to the current move.
  if(game.commitingMovelist)
    return;

  if(!fen)
    fen = game.history.last().fen;

  const hEntry = game.history.find(fen);

  if(!hEntry) {
    if(game.movelistRequested)
      return;

    if(move) {
      var newSubvariation = false;

      if(game.role === Role.NONE || game.isExamining()) {
        if(game.history.length() === 0)
          game.history.scratch(true);

        if(game.newVariationMode === NewVariationMode.NEW_VARIATION)
          newSubvariation = true;
        else if(game.newVariationMode === NewVariationMode.OVERWRITE_VARIATION)
          newSubvariation = false;
        else {
          newSubvariation = (!game.history.scratch() && !game.history.current().isSubvariation()) || // Make new subvariation if new move is on the mainline and we're not in scratch mode
              (game.history.editMode && game.history.current() !== game.history.current().last); // Make new subvariation if we are in edit mode and receive a new move from the server. Note: we never overwrite in edit mode unless the user explicitly requests it.
         }

        game.newVariationMode = NewVariationMode.ASK;
      }

      game.history.add(move, fen, newSubvariation, game.wtime, game.btime);
      getOpening(game);
      updateGameVariantMoveData(game);
      $('#game-pane-status').hide();
    }
    else {
      // move not found, request move list
      if(SupportedCategories.includes(game.category)) {
        game.movelistRequested++;
        session.send('iset startpos 1'); // Show the initial board position before the moves list
        session.send(`moves ${game.id}`);
        session.send('iset startpos 0');
      }
      else
        game.history.reset(game.fen, game.wtime, game.btime);
    }
  }
  else {
    if(!game.movelistRequested && game.role !== Role.NONE)
      game.history.updateClockTimes(hEntry, game.wtime, game.btime);

    if(hEntry === game.history.current())
      var sameMove = true;
    else if(game.isPlaying() || game.isObserving()) {
      if(hEntry !== game.history.last()) {
        game.board.cancelPremove();
        game.board.cancelPredrop();
      }
      while(hEntry !== game.history.last())
        game.history.removeLast(); // move is earlier, we need to take-back
    }
  }

  game.history.display(hEntry, move && !sameMove);
  if(!sameMove)
    updateEngine();

  if(game.removeMoveRequested && game.removeMoveRequested.prev === hEntry) {
    game.history.remove(game.removeMoveRequested);
    game.removeMoveRequested = null;
    if(game === games.focused && !game.history.hasSubvariation())
      $('#exit-subvariation').hide();
  }
}

/******************
 * GAME FUNCTIONS *
 ******************/

function createGame(): Game {
  var game = new Game();
  if(!games.length) {
    game.element = $('#main-board-area').children().first();
    game.statusElement = $('#game-status-list > :first-child');
    game.moveTableElement = $('#move-table > :first-child');
    game.moveListElement = $('#movelists > :first-child');
    game.board = mainBoard;
  }
  else {
    game.element = $('#main-board-area').children().first().clone();
    game.board = createBoard(game.element.find('.board'));
    leaveSetupBoard(game);
    makeSecondaryBoard(game);
    game.element.find($('[title="Close"]')).css('visibility', 'visible');
    $('#secondary-board-area').css('display', 'flex');
    $('#collapse-chat-arrow').show();
    game.element.find('[data-bs-toggle="tooltip"]').each(function() {
      Utils.createTooltip($(this));
    });

    game.statusElement = games.focused.statusElement.clone();
    game.statusElement.css('display', 'none');
    game.statusElement.appendTo($('#game-status-list'));

    game.moveTableElement = games.focused.moveTableElement.clone();
    game.moveTableElement.css('display', 'none');
    game.moveTableElement.appendTo($('#move-table'));

    game.moveListElement = games.focused.moveListElement.clone();
    game.moveListElement.css('display', 'none');
    game.moveListElement.appendTo($('#movelists'));

    $('#secondary-board-area')[0].scrollTop = $('#secondary-board-area')[0].scrollHeight; // Scroll secondary board area to the bottom

    $('#game-tools-close').parent().show();
  }

  function gameTouchHandler(event) {
    $('#input-text').trigger('blur');
    setGameWithFocus(game);
  }
  game.element[0].addEventListener('touchstart', gameTouchHandler, {passive: true});
  game.element[0].addEventListener('mousedown', gameTouchHandler);

  game.element.on('click', '[title="Close"]', (event) => {
    var game = games.focused;
    if(game.preserved || game.history.editMode)
      closeGameDialog(game);
    else
      closeGame(game);
    event.stopPropagation();
  });

  game.element.on('click', '[title="Maximize"]', (event) => {
    setGameWithFocus(game);
    maximizeGame(game);
  });

  game.element.on('dblclick', (event) => {
    if(games.getMainGame() === game)
      return;

    setGameWithFocus(game);
    maximizeGame(game);
  });

  game.clock = new Clock(game, checkGameEnd);
  games.add(game);
  setRightColumnSizes();

  return game;
}

export function setGameWithFocus(game: Game) {
  if(game !== games.focused) {
    if(games.focused) {
      games.focused.element.removeClass('game-focused');
      games.focused.moveTableElement.hide();
      games.focused.moveListElement.hide();
      games.focused.statusElement.hide();
      games.focused.board.setAutoShapes([]);
    }

    game.moveTableElement.show();
    game.moveListElement.show();
    game.statusElement.show();

    if(game.element.parent().attr('id') === 'secondary-board-area')
      game.element.addClass('game-focused');

    games.focused = game;

    setMovelistViewMode();
    initGameControls(game);

    updateBoard(game);
    updateEngine();
  }
}

function initGameControls(game: Game) {
  if(game !== games.focused)
    return;

  Utils.removeWithTooltips($('.context-menu'));
  initAnalysis(game);
  initGameTools(game);

  if(game.historyList.length > 1) {
    $('#game-list-button > .label').text(getGameListDescription(game.history, false));
    $('#game-list-button').show();
  }
  else
    $('#game-list-button').hide();

  if(!game.history || !game.history.hasSubvariation())
    $('#exit-subvariation').hide();

  if(game.isPlaying()) {
    $('#viewing-game-buttons').hide();

    // show Adjourn button for standard time controls or slower
    if(game.isPlayingOnline() && (game.time + game.inc * 2/3 >= 15 || (!game.time && !game.inc)))
      $('#adjourn').show();
    else
      $('#adjourn').hide();
    $('#playing-game-buttons').show();
  }
  else {
    $('#playing-game-buttons').hide();
    $('#viewing-game-buttons').show();
  }

  $('#takeback').prop('disabled', game.role === Role.PLAYING_COMPUTER);

  if((game.isExamining() || game.isObserving()) && !Utils.isSmallWindow())
    showPanel('#left-panel-header-2');
  else
    hidePanel('#left-panel-header-2');

  if(game.setupBoard)
    showPanel('#left-panel-setup-board');
  else
    hidePanel('#left-panel-setup-board');

  if(game.isExamining())
    Utils.showButton($('#stop-examining'));
  else if(game.isObserving())
    Utils.showButton($('#stop-observing'));

  if(!game.isExamining())
    Utils.hideButton($('#stop-examining'));
  if(!game.isObserving())
    Utils.hideButton($('#stop-observing'));

  if(game.isPlaying())
    showStatusPanel();
  else
    initStatusPanel();
}

function makeMainBoard(game: Game) {
  game.element.detach();
  game.element.removeClass('game-card-sm');
  game.element.removeClass('game-focused');
  game.element.find('.title-bar').css('display', 'none');
  game.element.appendTo('#main-board-area');
  game.board.set({ coordinates: true });
}

function makeSecondaryBoard(game: Game) {
  game.element.detach();
  game.element.find('.top-panel, .bottom-panel').css('height', '');
  game.element.addClass('game-card-sm');
  game.element.find('.title-bar').css('display', 'block');
  game.element.appendTo('#secondary-board-area');
  game.board.set({ coordinates: false });
}

export function maximizeGame(game: Game) {
  if(games.getMainGame() !== game) {
    Utils.animateBoundingRects(game.element, $('#main-board-area'), game.element.css('--border-expand-color'), game.element.css('--border-expand-width'));

    // Move currently maximized game card to secondary board area
    var prevMaximized = games.getMainGame();
    if(prevMaximized)
      makeSecondaryBoard(prevMaximized);
    else
      $('#main-board-area').empty();
    // Move card to main board area
    makeMainBoard(game);
    setPanelSizes();
    setFontSizes();
  }
  scrollToBoard(game);
}

function closeGameDialog(game: Game) {
  (window as any).closeGameClickHandler = (event) => {
    if(game)
      closeGame(game);
  };

  var headerTitle = 'Close Game';
  var bodyText = 'Really close game?';
  var button1 = [`closeGameClickHandler(event)`, 'OK'];
  var button2 = ['', 'Cancel'];
  var showIcons = true;
  Dialogs.showFixedDialog({type: headerTitle, msg: bodyText, btnFailure: button2, btnSuccess: button1, icons: showIcons});
}

function closeGame(game: Game) {
  if(!games.includes(game))
    return;

  if(game.isObserving() || game.isExamining())
    gameExitPending.push(game.id);

  if(game.isObserving())
    session.send(`unobs ${game.id}`);
  else if(game.isExamining())
    session.send('unex');
  removeGame(game);
}

function removeGame(game: Game) {
  // remove game from games list
  games.remove(game);

  // if we are removing the main game, choose the most important secondary game to maximize
  if(game.element.parent().is('#main-board-area')) {
    var newMainGame = games.getMostImportantGame();
    maximizeGame(newMainGame);
  }

  // If game currently had the focus, switch focus to the main game
  if(game === games.focused)
    setGameWithFocus(games.getMainGame());

  cleanupGame(game);

  // Remove game's html elements from the DOM
  game.element.remove();
  game.moveTableElement.remove();
  game.moveListElement.remove();
  game.statusElement.remove();

  // clean up circular references
  game.history = null;
  game.clock = null;

  if(!$('#secondary-board-area').children().length) {
    $('#secondary-board-area').hide();
    $('#collapse-chat-arrow').hide();
  }
  setRightColumnSizes();

  if(games.length === 1)
    $('#game-tools-close').parent().hide();
}

function cleanupGame(game: Game) {
  if(playEngine && game.role === Role.PLAYING_COMPUTER) {
    playEngine.terminate();
    playEngine = null;
  }

  game.role = Role.NONE;

  if(game === games.focused) {
    Utils.hideButton($('#stop-observing'));
    Utils.hideButton($('#stop-examining'));
    hidePanel('#left-panel-header-2');
    $('#takeback').prop('disabled', false);
    $('#play-computer').prop('disabled', false);
    $('#playing-game-buttons').hide();
    $('#viewing-game-buttons').show();
    $('#lobby-pane-status').hide();
  }

  game.element.find($('[title="Close"]')).css('visibility', 'visible');
  game.element.find('.title-bar-text').text('');
  game.statusElement.find('.game-id').remove();
  $(`.board-dialog[data-game-id="${game.id}"]`).toast('hide');

  if(chat)
    chat.closeGameTab(game.id);
  hidePromotionPanel(game);
  game.clock.stopClocks();

  if(game.watchersInterval)
    clearInterval(game.watchersInterval);
  game.watchersInterval = null;
  game.watchers = [];
  game.statusElement.find('.game-watchers').empty();

  game.id = null;
  game.partnerGameId = null;
  game.commitingMovelist = false;
  game.movelistRequested = 0;
  game.mexamineMovelist = null;
  game.gameStatusRequested = false;
  game.board.cancelMove();
  updateBoard(game);
  initStatusPanel();
  initGameTools(game);

  if($('#pills-play').hasClass('active') && $('#pills-lobby').hasClass('active'))
    initLobbyPane();

  game.bufferedHistoryEntry = null;
  game.bufferedHistoryCount = 0;
  game.removeMoveRequested = null;
}

async function getOpening(game: Game) {
  var historyItem = game.history.current();

  var fetchOpenings = async () => {
    var inputFilePath = 'assets/data/openings.tsv';
    openings = new Map();
    var chess = new Chess();
    await fetch(inputFilePath)
    .then(response => response.text())
    .then(data => {
      const rows = data.split('\n');
      for(const row of rows) {
        var cols = row.split('\t');
        if(cols.length === 4 && cols[2].startsWith('1.')) {
          var eco = cols[0];
          var name = cols[1];
          var moves = cols[2];
          var fen = cols[3];
          var fenNoPlyCounts = fen.split(' ').slice(0, -2).join(' ');
          openings.set(fenNoPlyCounts, {eco, name, moves});
        }
      }
    })
    .catch(error => {
      console.error('Couldn\'t fetch opening:', error);
    });
  };

  if(!openings && !fetchOpeningsPromise) {
    fetchOpeningsPromise = fetchOpenings();
  }
  await fetchOpeningsPromise;

  var fen = historyItem.fen.split(' ').slice(0, -2).join(' '); // Remove ply counts
  var opening = null;
  if(['blitz', 'lightning', 'untimed', 'standard', 'nonstandard'].includes(game.category))
    var opening = openings.get(fen);

  historyItem.opening = opening;
  game.history.updateOpeningMetatags();
}

/************************
 * NAVIGATION FUNCTIONS *
 ************************/

$('#fast-backward').off('click');
$('#fast-backward').on('click', () => {
  fastBackward();
});

function fastBackward() {
  var game = games.focused;
  gotoMove(game.history.first());
  if(!SupportedCategories.includes(game.category) && game.isExamining())
    session.send('back 999');
  showTab($('#pills-game-tab'));
}

$('#backward').off('click');
$('#backward').on('click', () => {
  backward();
});

function backward() {
  var game = games.focused;
  var move = bufferedCurrentMove(game).prev;

  if(move)
    gotoMove(move);
  else if(!SupportedCategories.includes(game.category) && game.isExamining())
    session.send('back');

  showTab($('#pills-game-tab'));
}

$('#forward').off('click');
$('#forward').on('click', () => {
  forward();
});

function forward() {
  var game = games.focused;
  var move = bufferedCurrentMove(game).next;

  if(move)
    gotoMove(move, true);
  else if(!SupportedCategories.includes(game.category) && game.isExamining())
    session.send('forward');

  showTab($('#pills-game-tab'));
}

$('#fast-forward').off('click');
$('#fast-forward').on('click', () => {
  fastForward();
});

function fastForward() {
  var game = games.focused;
  gotoMove(game.history.last());
  if(!SupportedCategories.includes(game.category) && game.isExamining())
    session.send('forward 999');

  showTab($('#pills-game-tab'));
}

$('#exit-subvariation').off('click');
$('#exit-subvariation').on('click', () => {
  exitSubvariation();
});

function exitSubvariation() {
  var curr = bufferedCurrentMove(games.focused);

  var prev = curr.first.prev;
  gotoMove(prev);
  showTab($('#pills-game-tab'));
}

function bufferedCurrentMove(game: Game) {
  return game.bufferedHistoryEntry || game.history.current();
}

export function gotoMove(to: HEntry, playSound = false) {
  if(!to)
    return;

  var game = games.focused;
  if(game.isExamining() && !game.setupBoard) {
    var from = bufferedCurrentMove(game);
    var curr = from;
    let i = 0;
    while(curr) {
      curr.visited = i;
      curr = curr.prev;
      i++;
    }
    var path = [];
    curr = to;
    while(curr && curr.visited === undefined) {
      path.push(curr);
      curr = curr.prev;
    }

    var backNum = curr.visited;
    if(backNum > 0) {
      session.send(`back ${backNum}`);
      game.bufferedHistoryEntry = curr;
      game.bufferedHistoryCount++;
    }

    while(from) {
      from.visited = undefined;
      from = from.prev;
    }

    var forwardNum = 0;
    if(!game.history.scratch()) {
      for(let i = path.length - 1; i >= 0; i--) {
        if(path[i].isSubvariation())
          break;
        curr = path[i];
        forwardNum++;
      }
      if(forwardNum > 0) {
        session.send(`for ${forwardNum}`);
        game.bufferedHistoryEntry = curr;
        game.bufferedHistoryCount++;
      }
    }

    for(let i = path.length - forwardNum - 1; i >= 0; i--) {
      sendMove(path[i].move);
      game.bufferedHistoryEntry = path[i];
      game.bufferedHistoryCount++;
    }
  }
  else {
    game.history.display(to, playSound);
    updateEngine();
    if(game.setupBoard)
      updateSetupBoard(game);
  }
}

function sendMove(move: any) {
  session.send(ChessHelper.moveToCoordinateString(move));
}

/**
 * Returns the game's current position. I.e. the move where new moves will be added from
 * This is different to game.history.current() which returns the move currently being viewed.
 */
function currentGameMove(game: Game): HEntry {
  return (game.isPlaying() || game.isObserving() ? game.history?.last() : game.history?.current());
}

/************************
 * LEFT MENUS FUNCTIONS *
 ************************/

$('#collapse-menus').on('hidden.bs.collapse', (event) => {
  $('#menus-toggle-icon').removeClass('fa-toggle-up').addClass('fa-toggle-down');

  activeTab = $('#pills-tab button').filter('.active');
  $('#pills-placeholder-tab').tab('show'); // switch to a hidden tab in order to hide the active one

  $('#collapse-menus').removeClass('collapse-init');
});

$('#collapse-menus').on('show.bs.collapse', (event) => {
  $('#menus-toggle-icon').removeClass('fa-toggle-down').addClass('fa-toggle-up');
  Utils.scrollToTop();
  activeTab.tab('show');
});

$('#collapse-menus').on('shown.bs.collapse', (event) => {
  setLeftColumnSizes();
});

$('#pills-tab button').on('shown.bs.tab', function(event) {
  if($(this).attr('id') !== 'pills-placeholder-tab') 
    activeTab = $(this);
  
  newTabShown = true;
  setTimeout(() => { newTabShown = false; }, 0);
});

$('#pills-tab button').on('click', function(event) {
  if(!newTabShown)
    $('#collapse-menus').collapse('hide');  
  else {
    activeTab = $(this);
    $('#collapse-menus').collapse('show');
    Utils.scrollToTop();
  }
});

function showTab(tab: any) {
  if($('#collapse-menus').hasClass('show')) 
    tab.tab('show');
  else
    activeTab = tab;
}

function showPanel(id: string) {
  var elem = $(id);
  elem.show();

  if(elem.closest('#left-col'))
    setLeftColumnSizes();
  else if(elem.closest('#right-col'))
    setRightColumnSizes();
  else
    setPanelSizes();
}

function hidePanel(id: string) {
  var elem = $(id);
  elem.hide();

  if(elem.closest('#left-col'))
    setLeftColumnSizes();
  else if(elem.closest('#right-col'))
    setRightColumnSizes();
  else
    setPanelSizes();
}

$('#stop-observing').on('click', (event) => {
  session.send(`unobs ${games.focused.id}`);
});

$('#stop-examining').on('click', (event) => {
  session.send('unex');
});

/***********************
 * PLAY PANEL FUCTIONS *
 ***********************/

$(document).on('shown.bs.tab', 'button[data-bs-target="#pills-play"]', (e) => {
  if($('#pills-lobby').hasClass('active'))
    initLobbyPane();
  else if($('#pills-pairing').hasClass('active'))
    initPairingPane();
});

$(document).on('hidden.bs.tab', 'button[data-bs-target="#pills-play"]', (e) => {
  $('#play-computer-modal').modal('hide');
  leaveLobbyPane();
});

$('#quick-game').on('click', (event) => {
  if(!games.getPlayingExaminingGame())
    session.send('getga');
});

/** PLAY COMPUTER FUNCTIONS **/

$('#play-computer-modal').on('show.bs.modal', (event) => {
  $('#play-computer-start-from-pos').removeClass('is-invalid');
});

$('#play-computer-form').on('submit', (event) => {
  event.preventDefault();

  const params = {
    playerColorOption: $('[name="play-computer-color"]:checked').next().text(),
    playerColor: '',
    playerTime: +$('#play-computer-min').val(),
    playerInc: +$('#play-computer-inc').val(),
    gameType: $('[name="play-computer-type"]:checked').next().text(),
    difficulty: $('[name="play-computer-level"]:checked').next().text(),
    fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'
  };

  if($('#play-computer-start-from-pos').prop('checked')) {
    var game = games.focused;
    if(game.setupBoard) 
      params.fen = getSetupBoardFEN(game);
    else {
      var fen: string = game.history.current().fen;
      var fenWords = ChessHelper.splitFEN(fen);
      fenWords.plyClock = '0';
      fenWords.moveNo = '1';
      params.fen = ChessHelper.joinFEN(fenWords);
    }

    var category = params.gameType.toLowerCase();
    if(params.gameType === 'Chess960')
      category = 'wild/fr';

    var err = ChessHelper.validateFEN(params.fen, category);
    if(err) {
      $('#play-computer-start-from-pos').addClass('is-invalid');
      return;
    }

    if(game.setupBoard && !game.isExamining()) 
      leaveSetupBoard(game);
  }
  else if(params.gameType === 'Chess960')
    params.fen = ChessHelper.generateChess960FEN();

  $('#play-computer-modal').modal('hide');

  if(params.playerColorOption === 'Any') {
    if(!lastComputerGame)
      params.playerColor = (Math.random() < 0.5 ? 'White' : 'Black');
    else
      params.playerColor = (lastComputerGame.playerColor === 'White' ? 'Black' : 'White');
  }
  else
    params.playerColor = params.playerColorOption;

  lastComputerGame = params;
  playComputer(params);
});

function playComputer(params: any) {
  var computerGame = games.getComputerGame();
  if(computerGame) {
    cleanupGame(computerGame);
    var game = computerGame;
  }
  else if(!settings.multiboardToggle)
    var game = games.getMainGame();
  else {
    var game = games.getFreeGame();
    if(!game)
      game = createGame();
  }

  game.id = -1;

  var playerName = (session.isConnected() ? session.getUser() : 'Player');
  var playerTimeRemaining = params.playerTime * 60000;
  if(params.playerTime === 0) {
    if(params.playerInc === 0)
      playerTimeRemaining = null; // untimed game
    else
      playerTimeRemaining = 10000; // if initial player time is 0, player gets 10 seconds
  }

  var wname = (params.playerColor === 'White' ? playerName : 'Computer');
  var bname = (params.playerColor === 'Black' ? playerName : 'Computer');

  var category = params.gameType.toLowerCase();
  if(params.gameType === 'Chess960')
    category = 'wild/fr';

  var turnColor = ChessHelper.getTurnColorFromFEN(params.fen);

  var data = {
    fen: params.fen,                        // game state
    turn: turnColor,                        // color whose turn it is to move ("B" or "W")
    id: -1,                                 // The game number
    wname: wname,                           // White's name
    bname: bname,                           // Black's name
    wrating: '',                            // White's rating
    brating: '',                            // Black's rating
    role: Role.PLAYING_COMPUTER,            // my relation to this game
    time: params.playerTime,                // initial time in seconds
    inc: params.playerInc,                  // increment per move in seconds
    wtime: (params.playerColor === 'White' ? playerTimeRemaining : null), // White's remaining time
    btime: (params.playerColor === 'Black' ? playerTimeRemaining : null), // Black's remaining time
    moveNo: 1,                              // the number of the move about to be made
    move: 'none',                           // pretty notation for the previous move ("none" if there is none)
    flip: (params.playerColor === 'White' ? false : true), // whether game starts with board flipped
    category: category,                     // game variant or type
    color: params.playerColor === 'White' ? 'w' : 'b',
    difficulty: params.difficulty           // Computer difficulty level
  }

  // Show game status mmessage
  var computerName = `Computer (Lvl ${params.difficulty})`;
  if(params.playerColor === 'White')
    bname = computerName;
  else
    wname = computerName;
  let time = ` ${params.playerTime} ${params.playerInc}`;
  if(params.playerTime === 0 && params.playerInc === 0)
    time = '';
  let gameType = '';
  if(params.gameType !== 'Standard')
    gameType = ` ${params.gameType}`;
  const statusMsg = `${wname} vs. ${bname}${gameType}${time}`;
  showStatusMsg(game, statusMsg);

  messageHandler(data);
}

function getPlayComputerEngineOptions(game: Game): object {
  var skillLevels = [0, 1, 2, 3, 5, 7, 9, 11, 13, 15]; // Skill Level for each difficulty level

  var engineOptions = {}
  if(game.category === 'wild/fr')
    engineOptions['UCI_Chess960'] = true;
  else if(game.category === 'crazyhouse')
    engineOptions['UCI_Variant'] = game.category;

  engineOptions['Skill Level'] = skillLevels[game.difficulty - 1];

  return engineOptions;
}

function getPlayComputerMoveParams(game: Game): string {
  // Max nodes for each difficulty level. This is also used to limit the engine's thinking time
  // but in a way that keeps the difficulty the same across devices
  var maxNodes = [100000, 200000, 300000, 400000, 500000, 600000, 700000, 800000, 900000, 1000000];
  var moveParams = `nodes ${maxNodes[game.difficulty - 1]}`;

  return moveParams;
}

function playComputerBestMove(game: Game, bestMove: string, score: string = '=0.00') {
  var move;
  if(bestMove[1] === '@') // Crazyhouse/bughouse
    move = bestMove;
  else
    move = {
      from: bestMove.slice(0,2),
      to: bestMove.slice(2,4),
      promotion: (bestMove.length === 5 ? bestMove[4] : undefined)
    }

  game.lastComputerMoveEval = score;

  var parsedMove = parseGameMove(game, game.history.last().fen, move);

  var moveData = {
    role: Role.PLAYING_COMPUTER,                      // game mode
    id: -1,                                           // game id, always -1 for playing computer
    fen: parsedMove.fen,                              // board/game state
    turn: ChessHelper.getTurnColorFromFEN(parsedMove.fen), // color whose turn it is to move ("B" or "W")
    wtime: game.clock.getWhiteTime(),                      // White's remaining time
    btime: game.clock.getBlackTime(),                      // Black's remaining time
    moveNo: ChessHelper.getMoveNoFromFEN(parsedMove.fen), // the number of the move about to be made
    moveVerbose: parsedMove,                          // verbose coordinate notation for the previous move ("none" if there werenone) [note this used to be broken for examined games]
    move: parsedMove.move.san,                        // pretty notation for the previous move ("none" if there is none)
  }
  messageHandler(moveData);
}

// Get Computer's next move either from the opening book or engine
async function getComputerMove(game: Game) {
  var bookMove = '';
  if(game.category === 'standard') { // only use opening book with normal chess
    var fen = game.history.last().fen;
    var moveNo = ChessHelper.getMoveNoFromFEN(fen);
    // Cool-down function for deviating from the opening book. The chances of staying in book
    // decrease with each move
    var coolDownParams = [
      { slope: 0.2, shift: 1.0 }, // Difficulty level 1
      { slope: 0.2, shift: 1.2 }, // 2
      { slope: 0.2, shift: 1.4 }, // 3
      { slope: 0.2, shift: 1.6 }, // 4
      { slope: 0.2, shift: 1.8 }, // 5
      { slope: 0.2, shift: 2.0 }, // 6
      { slope: 0.2, shift: 2.5 }, // 7
      { slope: 0.2, shift: 3.0 }, // 8
      { slope: 0.2, shift: 3.5 }, // 9
      { slope: 0.2, shift: 4.0 }, // 10
    ];
    let a = coolDownParams[game.difficulty - 1].slope;
    let b = coolDownParams[game.difficulty - 1].shift;
    let x = moveNo;
    var sigma = 1 / (1 + Math.exp(a*x - b));
    if(Math.random() < sigma) {
      // Use book move (if there is one)
      var bookMoves = await getBookMoves(fen);
      var totalWeight = bookMoves.reduce((acc, curr) => acc + curr.weight, 0);
      var probability = 0;
      var rValue = Math.random();
      for(let bm of bookMoves) {
        probability += bm.weight / totalWeight; // polyglot moves are weighted based on number of wins and draws
        if(rValue <= probability) {
          bookMove = `${bm.from}${bm.to}`;
          break;
        }
      }
    }
  }

  if(bookMove)
    playComputerBestMove(game, bookMove);
  else
    playEngine.move(game.history.last());
}

async function getBookMoves(fen: string): Promise<any[]> {
  if(!book)
    book = new Polyglot("assets/data/gm2600.bin");

  var entries = await book.getMovesFromFen(fen);
  return entries;
}

(window as any).rematchComputer = () => {
  if(lastComputerGame.playerColorOption === 'Any')
    lastComputerGame.playerColor = (lastComputerGame.playerColor === 'White' ? 'Black' : 'White');
  playComputer(lastComputerGame);
};

function checkGameEnd(game: Game) {
  if(game.role !== Role.PLAYING_COMPUTER)
    return;

  var gameEnd = false;
  var isThreefold = game.history.isThreefoldRepetition();
  var winner = '', loser = '';
  var lastMove = game.history.last();
  var turnColor = lastMove.turnColor;
  var fen = lastMove.fen;
  var chess = new Chess(fen);
  var gameStr = `(${game.wname} vs. ${game.bname})`;

  // Check white or black is out of time
  if(game.clock.getWhiteTime() < 0 || game.clock.getBlackTime() < 0) {
    var wtime = game.clock.getWhiteTime();
    var btime = game.clock.getBlackTime();

    // Check if the side that is not out of time has sufficient material to mate, otherwise its a draw
    var insufficientMaterial = false;
    if(wtime < 0)
      var fen = chess.fen().replace(' w ', ' b '); // Set turn color to the side not out of time in order to check their material
    else if(btime < 0)
      var fen = chess.fen().replace(' b ', ' w ');

    chess.load(fen);
    insufficientMaterial = chess.insufficient_material();

    if(insufficientMaterial) {
      var reason = Reason.Draw;
      var reasonStr = `${wtime < 0 ? game.wname : game.bname} ran out of time and ${wtime >= 0 ? game.wname : game.bname} has no material to mate`;
      var scoreStr = '1/2-1/2';
    }
    else {
      winner = (wtime >= 0 ? game.wname : game.bname);
      loser = (wtime < 0 ? game.wname : game.bname);
      var reason = Reason.TimeForfeit;
      var reasonStr = `${loser} forfeits on time`;
      var scoreStr = (winner === game.wname ? '1-0' : '0-1');
    }
    gameEnd = true;
  }
  else if(chess.in_checkmate()) {
    winner = (turnColor === 'w' ? game.bname : game.wname);
    loser = (turnColor === 'w' ? game.wname : game.bname);
    var reason = Reason.Checkmate;
    var reasonStr = `${loser} checkmated`;
    var scoreStr = (winner === game.wname ? '1-0' : '0-1');

    gameEnd = true;
  }
  else if(chess.in_draw() || isThreefold) {
    var reason = Reason.Draw;
    var scoreStr = '1/2-1/2';

    if(isThreefold)
      var reasonStr = 'Game drawn by repetition';
    else if(chess.insufficient_material())
      var reasonStr = 'Neither player has mating material';
    else if(chess.in_stalemate())
      var reasonStr = 'Game drawn by stalemate';
    else
      var reasonStr = 'Game drawn by the 50 move rule';

    gameEnd = true;
  }

  if(gameEnd) {
    var gameEndData = {
      game_id: -1,
      winner,
      loser,
      reason,
      score: scoreStr,
      message: `${gameStr} ${reasonStr} ${scoreStr}`
    };
    messageHandler(gameEndData);
  }
}

/** PAIRING PANE FUNCTIONS **/

$(document).on('shown.bs.tab', 'button[data-bs-target="#pills-pairing"]', (e) => {
  initPairingPane();
});

function initPairingPane() {
  // If user has changed from unregistered to registered or vice versa, set Rated/Unrated option
  // in pairing panel appopriately.
  if(session && isRegistered !== session.isRegistered()) {
    isRegistered = session.isRegistered();
    $('#rated-unrated-button').text((isRegistered ? 'Rated' : 'Unrated'));
  }
}

function clearMatchRequests() {
  matchRequested = 0;
  $('#sent-offers-status').html('');
  $('#sent-offers-status').hide();
}

$('#custom-control').on('submit', (event) => {
  event.preventDefault();

  $('#custom-control-go').trigger('focus');
  const min: string = Utils.getValue('#custom-control-min');
  const sec: string = Utils.getValue('#custom-control-inc');
  getGame(+min, +sec);

  return false;
});

function getGame(min: number, sec: number) {
  let opponent = Utils.getValue('#opponent-player-name')
  opponent = opponent.trim().split(/\s+/)[0];
  $('#opponent-player-name').val(opponent);

  var ratedUnrated = ($('#rated-unrated-button').text() === 'Rated' ? 'r' : 'u');
  var colorName = $('#player-color-button').text();
  var color = '';
  if(colorName === 'White')
    color = 'W ';
  else if(colorName === 'Black')
    color = 'B ';

  matchRequested++;

  const cmd: string = (opponent !== '') ? `match ${opponent}` : 'seek';
  var mainGame = games.getPlayingExaminingGame();
  if(mainGame && mainGame.isExamining())
    session.send('unex');
  session.send(`${cmd} ${min} ${sec} ${ratedUnrated} ${color}${newGameVariant}`);
}
(window as any).getGame = getGame;

(window as any).setNewGameColor = (option: string) => {
  $('#player-color-button').text(option);
};

(window as any).setNewGameRated = (option: string) => {
  if(!session.isRegistered() && option === 'Rated') {
    $('#rated-unrated-menu').popover({
      animation: true,
      content: 'You must be registered to play rated games. <a href="https://www.freechess.org/cgi-bin/Register/FICS_register.cgi?Language=English" target="_blank">Register now</a>.',
      html: true,
      placement: 'top',
    });
    $('#rated-unrated-menu').popover('show');
    return;
  }

  $('#rated-unrated-button').text(option);
};

(window as any).setNewGameVariant = (title: string, command: string) => {
  newGameVariant = command;
  $('#variants-button').text(title);
  if(command === 'bughouse')
    $('#opponent-player-name').attr('placeholder', 'Enter opponent\'s username');
  else
    $('#opponent-player-name').attr('placeholder', 'Anyone');
};

$('#puzzlebot').on('click', (event) => {
  session.send('t puzzlebot getmate');
  showTab($('#pills-game-tab'));
});

/** LOBBY PANE FUNCTIONS **/

$(document).on('shown.bs.tab', 'button[data-bs-target="#pills-lobby"]', (e) => {
  initLobbyPane();
});

function initLobbyPane() {
  var game = games.getPlayingExaminingGame();
  if(!session || !session.isConnected())
    $('#lobby').hide();
  else if(game && (game.isExamining() || game.isPlayingOnline())) {
    if(game.isExamining())
      $('#lobby-pane-status').text('Can\'t enter lobby while examining a game.');
    else
      $('#lobby-pane-status').text('Can\'t enter lobby while playing a game.');
    $('#lobby-pane-status').show();
    $('#lobby').hide();
  }
  else {
    $('#lobby-pane-status').hide();
    if(session.isRegistered())
      $('#lobby-show-unrated').parent().show();
    else
      $('#lobby-show-unrated').parent().hide();

    if(settings.lobbyShowComputersToggle) {
      $('#lobby-show-computers-icon').removeClass('fa-eye-slash');
      $('#lobby-show-computers-icon').addClass('fa-eye');
    }
    else {
      $('#lobby-show-computers-icon').removeClass('fa-eye');
      $('#lobby-show-computers-icon').addClass('fa-eye-slash');
    }

    if(settings.lobbyShowUnratedToggle) {
      $('#lobby-show-unrated-icon').removeClass('fa-eye-slash');
      $('#lobby-show-unrated-icon').addClass('fa-eye');
    }
    else {
      $('#lobby-show-unrated-icon').removeClass('fa-eye');
      $('#lobby-show-unrated-icon').addClass('fa-eye-slash');
    }

    $('#lobby-show-computers').prop('checked', settings.lobbyShowComputersToggle);
    $('#lobby-show-unrated').prop('checked', settings.lobbyShowUnratedToggle);
    $('#lobby').show();
    $('#lobby-table').html('');
    lobbyScrolledToBottom = true;
    lobbyRequested = true;
    lobbyEntries.clear();
    session.send('iset seekremove 1');
    session.send('iset seekinfo 1');
  }
}

$(document).on('hidden.bs.tab', 'button[data-bs-target="#pills-lobby"]', (e) => {
  leaveLobbyPane();
});

function leaveLobbyPane() {
  if(lobbyRequested) {
    $('#lobby-table').html('');
    lobbyRequested = false;

    if (session && session.isConnected()) {
      session.send('iset seekremove 0');
      session.send('iset seekinfo 0');
    }
  }
}

$('#lobby-show-computers').on('change', function (e) {
  settings.lobbyShowComputersToggle = $(this).is(':checked');
  storage.set('lobbyshowcomputers', String(settings.lobbyShowComputersToggle));
  initLobbyPane();
});

$('#lobby-show-unrated').on('change', function (e) {
  settings.lobbyShowUnratedToggle = $(this).is(':checked');
  storage.set('lobbyshowunrated', String(settings.lobbyShowUnratedToggle));
  initLobbyPane();
});

$('#lobby-table-container').on('scroll', (e) => {
  var container = $('#lobby-table-container')[0];
  lobbyScrolledToBottom = container.scrollHeight - container.clientHeight < container.scrollTop + 1.5;
});

function formatLobbyEntry(seek: any): string {
  var title = (seek.title !== '' ? `(${seek.title})` : '');
  var color = (seek.color !== '?' ? ` ${seek.color}` : '');
  var rating = (seek.rating !== '' ? `(${seek.rating})` : '');
  return `${seek.toFrom}${title}${rating} ${seek.initialTime} ${seek.increment} `
    + `${seek.ratedUnrated} ${seek.category}${color}`;
}

(window as any).acceptSeek = (id: number) => {
  matchRequested++;
  session.send(`play ${id}`);
};

/*************************** 
 * OBSERVE PANEL FUNCTIONS *
 ***************************/

$(document).on('shown.bs.tab', 'button[data-bs-target="#pills-observe"]', (e) => {
  initObservePane();
});

function initObservePane() {
  obsRequested = 0;
  $('#games-table').html('');
  if (session && session.isConnected()) {
    gamesRequested = true;
    session.send('games');
  }
}

$('#observe-user').on('submit', (event) => {
  event.preventDefault();
  $('#observe-go').trigger('focus');
  observe();
  return false;
});

(window as any).observeGame = (id: string) => {
  observe(id);
};

function observe(id?: string) {
  if(!id) {
    id = Utils.getValue('#observe-username');
    id = id.trim().split(/\s+/)[0];
    $('#observe-username').val(id);
  }
  if(id.length > 0) {
    obsRequested++;
    session.send(`obs ${id}`);
  }
}

function showGames(games: string) {
  if (!$('#pills-observe').hasClass('active')) {
    return;
  }

  $('#observe-pane-status').hide();

  for (const g of games.split('\n').slice(0, -2).reverse()) {
    var match = g.match(/\s*(\d+)\s+(\(Exam\.\s+)?(\S+)\s+(\w+)\s+(\S+)\s+(\w+)\s*(\)\s+)?(\[\s*)(\w+)(.*)/);
    if(match) {
      var id = match[1];

      if(match[9].startsWith('p')) // Don't list private games
        continue;

      computerList.forEach(comp => {
        if(comp === match[4] || (match[4].length >= 10 && comp.startsWith(match[4])))
          match[4] += '(C)';
        if(comp === match[6] || (match[6].length >= 10 && comp.startsWith(match[6])))
          match[6] += '(C)';
      });

      var gg = match.slice(1).join(' ')

      $('#games-table').append(
        `<button type="button" class="w-100 btn btn-outline-secondary" onclick="observeGame('${id}');">`
          + `${gg}</button>`);
    }
  }
}

/***************************
 * HISTORY PANEL FUNCTIONS *
 ***************************/

$(document).on('shown.bs.tab', 'button[data-bs-target="#pills-history"]', (e) => {
  initHistoryPane();
});

function initHistoryPane() {
  historyRequested = 0;
  $('#history-table').html('');
  let username = Utils.getValue('#history-username');
  if (username === undefined || username === '') {
    if (session) {
      username = session.getUser();
      $('#history-username').val(username);
    }
  }
  getHistory(username);
}

$('#history-user').on('submit', (event) => {
  event.preventDefault();
  $('#history-go').trigger('focus');
  const username = Utils.getValue('#history-username');
  getHistory(username);
  return false;
});

function getHistory(user: string) {
  if (session && session.isConnected()) {
    user = user.trim().split(/\s+/)[0];
    if(user.length === 0)
      user = session.getUser();
    $('#history-username').val(user);
    historyRequested++;
    session.send(`hist ${user}`);
  }
}

export function parseHistory(history: string) {
  const h = history.split('\n');
  h.splice(0, 2);
  return h;
}

function showHistory(user: string, history: string) {
  if (!$('#pills-history').hasClass('active')) {
    return;
  }

  $('#history-pane-status').hide();
  $('#history-table').html('');

  const exUser = Utils.getValue('#history-username');
  if (exUser.localeCompare(user, undefined, { sensitivity: 'accent' }) !== 0) {
    return;
  }
  const hArr = parseHistory(history);
  for(let i = hArr.length - 1; i >= 0; i--) {
    const id = hArr[i].slice(0, hArr[i].indexOf(':'));
    $('#history-table').append(
      `<button type="button" class="w-100 btn btn-outline-secondary" onclick="examineGame('${user}', `
        + `'${id}');">${hArr[i]}</button>`);
  }
}

(window as any).examineGame = (user, id) => {
  var game = games.getPlayingExaminingGame();
  if(game && game.isExamining())
    session.send('unex');
  session.send(`ex ${user} ${id}`);
};

/************************
 * GAME PANEL FUNCTIONS *  
 ************************/

$(document).on('show.bs.tab', 'button[data-bs-target="#pills-game"]', (e) => {
  if($('#game-list-view').is(':checked'))
    $('#left-panel').addClass('list-view-showing');
});

$(document).on('hide.bs.tab', 'button[data-bs-target="#pills-game"]', (e) => {
  $('#left-panel').removeClass('list-view-showing');
});

(window as any).showGameTab = () => {
  showTab($('#pills-game-tab'));
};

$('#move-table').on('click', '.selectable', function() {
  gotoMove($(this).data('hEntry'));
});

$('#movelists').on('click', '.move', function() {
  gotoMove($(this).parent().data('hEntry'));
});

$('#movelists').on('click', '.comment', function() {
  if($(this).hasClass('comment-before'))
    gotoMove($(this).next().data('hEntry'));
  else
    gotoMove($(this).prev().data('hEntry'));
});

/**
 * Create right-click and long press trigger events for displaying the context menu when right clicking a move
 * in the move list.
 */
Utils.createContextMenuTrigger(function(event) {
  var target = $(event.target);
  return !!(target.closest('.selectable').length || target.closest('.move').length
      || (target.closest('.comment').length && event.type === 'contextmenu'));
}, createMoveContextMenu);

/**
 * Create context menu after a move (or associated comment) is right-clicked, with options for adding
 * comments / annotations, deleting the move (and all following moves in that variation), promoting the
 * variation etc.
 */
function createMoveContextMenu(event: any) {
  var contextMenu = $(`<ul class="context-menu dropdown-menu"></ul>`);
  if($(event.target).closest('.comment-before').length)
    var moveElement = $(event.target).next();
  else if($(event.target).closest('.comment-after').length)
    var moveElement = $(event.target).prev();
  else if($(event.target).closest('.outer-move').length)
    var moveElement = $(event.target).closest('.outer-move');
  else
    var moveElement = $(event.target).closest('.selectable');

  moveElement.find('.move').addClass('hovered'); // Show the :hovered style while menu is displayed

  var hEntry = moveElement.data('hEntry');
  var game = games.focused;

  if(hEntry === hEntry.first || (!hEntry.parent && hEntry.prev === hEntry.first)) {
    // If this is the first move in a subvariation, allow user to add a comment both before and after the move.
    // The 'before comment' allows the user to add a comment for the subvariation in general.
    contextMenu.append(`<li><a class="dropdown-item noselect" data-action="edit-comment-before">Edit Comment Before</a></li>`);
    contextMenu.append(`<li><a class="dropdown-item noselect" data-action="edit-comment-after">Edit Comment After</a></li>`);
  }
  else
    contextMenu.append(`<li><a class="dropdown-item noselect" data-action="edit-comment-after">Edit Comment</a></li>`);
  if(hEntry.nags.length)
    contextMenu.append(`<li><a class="dropdown-item noselect" data-action="delete-annotation">Delete Annotation</a></li>`);
  if(!game.isObserving() && !game.isPlaying()) {
    contextMenu.append(`<li><a class="dropdown-item noselect" data-action="delete-move">Delete Move</a></li>`);
    if(hEntry.parent)
      contextMenu.append(`<li><a class="dropdown-item noselect" data-action="promote-variation">Promote Variation</a></li>`);
    else if(hEntry.prev !== hEntry.first)
      contextMenu.append(`<li><a class="dropdown-item noselect" data-action="make-continuation">Make Continuation</a></li>`);
  }
  contextMenu.append(`<li><a class="dropdown-item noselect" data-action="clear-all-analysis">Clear All Analysis</a></li>`);
  contextMenu.append(`<li><hr class="dropdown-divider"></li>`);
  var annotationsHtml = `<div class="annotations-menu annotation">`;
  for(let a of History.annotations)
    annotationsHtml += `<li><a class="dropdown-item noselect" data-bs-toggle="tooltip" data-nags="${a.nags}" title="${a.description}">${a.symbol}</a></li>`;
  annotationsHtml += `</div>`;
  contextMenu.append(annotationsHtml);
  contextMenu.find('[data-bs-toggle="tooltip"]').each((index, element) => {
    Utils.createTooltip($(element));
  });

  /** Called when menu item is selected */
  var moveContextMenuItemSelected = (event: any) => {
    moveElement.find('.move').removeClass('hovered');
    var target = $(event.target);
    var nags = target.attr('data-nags');
    if(nags)
      game.history.setAnnotation(hEntry, nags);
    else {
      var action = target.attr('data-action');
      switch(action) {
        case 'edit-comment-before':
          setViewModeList(); // Switch to List View so the user can edit the comment in-place.
          gotoMove(hEntry);
          game.history.editCommentBefore(hEntry);
          break;
        case 'edit-comment-after':
          setViewModeList();
          gotoMove(hEntry);
          game.history.editCommentAfter(hEntry);
          break;
        case 'delete-annotation':
          game.history.removeAnnotation(hEntry);
          break;
        case 'delete-move':
          deleteMove(game, hEntry);
          break;
        case 'promote-variation':
          if(game.isExamining() && !game.history.scratch() && hEntry.depth() === 1) {
            // If we are promoting a subvariation to the mainline, we need to 'commit' the new mainline
            var current = game.history.current();
            gotoMove(hEntry.last);
            session.send('commit');
          }
          game.history.promoteSubvariation(hEntry);
          if(current)
            gotoMove(current);

          updateEditMode(game, true);
          if(!game.history.hasSubvariation())
            $('#exit-subvariation').hide();
          break;
        case 'make-continuation':
          if(game.isExamining() && !game.history.scratch() && hEntry.depth() === 0) {
            var current = game.history.current();
            gotoMove(hEntry.prev);
            session.send('truncate');
          }
          game.history.makeContinuation(hEntry);
          if(current)
            gotoMove(current);
          updateEditMode(game, true);
          $('#exit-subvariation').show();
          break;
        case 'clear-all-analysis':
          clearAnalysisDialog(game);
          break;
      }
    }
  };

  var moveContextMenuClose = (event: any) => {
    moveElement.find('.move').removeClass('hovered');
  }

  var coords = Utils.getTouchClickCoordinates(event);
  Utils.createContextMenu(contextMenu, coords.x, coords.y, moveContextMenuItemSelected, moveContextMenuClose);
}

/**
 * Removes a move (and all following moves) from the move list / move table
 */
function deleteMove(game: Game, entry: HEntry) {
  if(game.history.current().isPredecessor(entry)) {
    // If the current move is on the line we are just about to delete, we need to back out of it first
    // before deleting the line.
    gotoMove(entry.prev);
    if(game.isExamining())
      game.removeMoveRequested = entry;
    else {
      game.history.remove(entry);
      if(!game.history.hasSubvariation())
        $('#exit-subvariation').hide();
    }
  }
}

/**
 * Removes all sub-variations, comments and annotations from the move-list / move-table
 */
function clearAnalysisDialog(game: Game) {
  (window as any).clearAnalysisClickHandler = (event) => {
    if(game) {
      // Delete all subvariations from the main line
      var hEntry = game.history.first();
      while(hEntry) {
        for(let i = hEntry.subvariations.length - 1; i >= 0; i--)
          deleteMove(game, hEntry.subvariations[i]);
        hEntry = hEntry.next;
      }
      game.history.removeAllAnnotations();
      game.history.removeAllComments();
    }
  };

  var headerTitle = 'Clear All Analysis';
  var bodyText = 'Really clear all analysis?';
  var button1 = [`clearAnalysisClickHandler(event)`, 'OK'];
  var button2 = ['', 'Cancel'];
  var showIcons = true;
  Dialogs.showFixedDialog({type: headerTitle, msg: bodyText, btnFailure: button2, btnSuccess: button1, icons: showIcons});
}

/** GAME PANEL TOOLBAR AND TOOL MENU FUNCTIONS **/

/**
 * Initializes the controls in the Game Panel toolbar and tool menu when a game gains the focus
 * or when a game starts or ends
 */
function initGameTools(game: Game) {
  if(game === games.focused) {
    updateGamePreserved(game);
    updateEditMode(game);
    $('#game-tools-clone').parent().toggle(settings.multiboardToggle); // Only show 'Duplicate GAme' option in multiboard mode
    $('#game-tools-clone').toggleClass('disabled', game.isPlaying()); // Don't allow cloning of a game while playing (could allow cheating)

    var mainGame = games.getPlayingExaminingGame();
    $('#game-tools-examine').toggleClass('disabled', (mainGame && mainGame.isPlayingOnline()) || game.isPlaying() || game.isExamining()
        || game.category === 'wild/fr' || game.category === 'wild/0' // Due to a bug in 'bsetup' it's not possible to convert some wild variants to examine mode
        || game.category === 'wild/1' || game.category === 'bughouse');

    $('#game-tools-setup-board').toggleClass('disabled', game.setupBoard || game.isPlaying() || game.isObserving()
        || (game.isExamining() && (game.category === 'wild/fr' || game.category === 'wild/0'
        || game.category === 'wild/1' || game.category === 'bughouse')));
  }
}

/** Triggered when Table View button is toggled on/off */
$('#game-table-view').on('change', function() {
  if($('#game-table-view').is(':checked'))
    setViewModeTable();
});

/** Triggered when List View button is toggled on/off */
$('#game-list-view').on('change', function() {
  if($('#game-list-view').is(':checked'))
    setViewModeList();
});

/**
 * Stops the Table View / List View radio buttons from stealing left-arrow key / right-arrow key
 * input from the move-list
 */
$('#game-table-view, #game-list-view').on('keydown', function(event) {
  if(event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
    event.preventDefault();
    $(document).trigger($.Event('keydown', {
      key: event.key,
      altKey: event.altKey,
      ctrlKey: event.ctrlKey,
      shiftKey: event.shiftKey,
      metaKey: event.metaKey
    }));
  }
});

/**
 * Set move list view mode to Table View
 */
function setViewModeTable() {
  $('#left-panel').removeClass('list-view-showing');
  $('#movelists').hide();
  $('#move-table').show();
  $('#game-table-view').prop('checked', true);
  games.focused.history.highlightMove();
}

/**
 * Set move list view mode to List View
 */
function setViewModeList() {
  if($('#pills-game').is(':visible'))
    $('#left-panel').addClass('list-view-showing');
  $('#move-table').hide();
  $('#movelists').show();
  $('#game-list-view').prop('checked', true);
  games.focused.history.highlightMove();
}

/**
 * Sets the move list view mode based on which toggle button is currently selected
 */
function setMovelistViewMode() {
  if($('#game-table-view').is(':checked'))
    setViewModeTable();
  else
    setViewModeList();
}

/** Triggered when Edit Mode toggle button is toggled on/off */
$('#game-edit-mode').on('change', function (e) {
  updateEditMode(games.focused, $(this).is(':checked'));
});

/**
 * Updates Edit Mode toggle button based on game setting
 */
function updateEditMode(game: Game, editMode?: boolean) {
  if(!game.history)
    return;

  if(editMode !== undefined)
    game.history.editMode = editMode;
  $('#game-edit-mode').prop('checked', game.history.editMode);
}

/** Triggered when Game Preserved toggle button is toggled on/off */
$('#game-preserved').on('change', function (e) {
  updateGamePreserved(games.focused, $(this).is(':checked'));
});

/**
 * Updates Game Preserved toggle button based on game setting
 */
function updateGamePreserved(game: Game, preserved?: boolean) {
  if(preserved !== undefined)
    game.preserved = preserved;

  var label = $('label[for="game-preserved"]');
  if(settings.multiboardToggle) {
    $('#game-preserved').show();
    label.show();
    $('#game-preserved').attr('aria-checked', String(game.preserved));
    $('#game-preserved').prop('checked', game.preserved);
    if(game.preserved)
      label.find('span').removeClass('fa-unlock').addClass('fa-lock');
    else
      label.find('span').removeClass('fa-lock').addClass('fa-unlock');
  }
  else {
    $('#game-preserved').hide();
    label.hide();
  }
}

/** New Game menu item selected */
$('#game-tools-new').on('click', (event) => {
  newGameDialog();
});

/** New Variant Game menu item selected */
$('#new-variant-game-submenu a').on('click', (event) => {
  var category = $(event.target).text();
  if(category === 'Chess960')
    category = 'wild/fr';

  category = category.toLowerCase();
  newGameDialog(category);
});

/**
 * When creating a new (empty game), shows a dialog asking if the user wants to Overwrite the
 * current game or open a New Board. For Chess960, also lets select Chess960 starting position
 */
function newGameDialog(category: string = 'untimed') {
  var bodyText = '';

  if(category === 'wild/fr') {
    var bodyText =
      `<label for"chess960idn">Chess960 Starting Position ID (Optional)</label>
      <input type="number" min="0" max="959" placeholder="0-959" class="form-control text-center chess960idn"><br>`;
  }

  var overwriteHandler = function(event) {
    if(category === 'wild/fr')
      var chess960idn = this.closest('.toast').querySelector('.chess960idn').value;
    newGame(false, category, null, chess960idn);
  };

  var newBoardHandler = function(event) {
    if(category === 'wild/fr')
      var chess960idn = this.closest('.toast').querySelector('.chess960idn').value;
    newGame(true, category, null, chess960idn);
  };

  var button1: any, button2: any;
  if(games.focused.role === Role.NONE || (category === 'wild/fr' && settings.multiboardToggle)) {
    var headerTitle = 'Create new game';
    var bodyTitle = '';
    if(games.focused.role === Role.NONE && settings.multiboardToggle) {
      var bodyText = `${bodyText}Overwrite existing game or open new board?`;
      button1 = [overwriteHandler, 'Overwrite'];
      button2 = [newBoardHandler, 'New Board'];
      var showIcons = false;
    }
    else if(games.focused.role === Role.NONE) {
      var bodyText = `${bodyText}This will clear the current game.`;
      button1 = [overwriteHandler, 'OK'];
      button2 = ['', 'Cancel'];
      var showIcons = true;
    }
    else if(category === 'wild/fr' && settings.multiboardToggle) {
      button1 = [newBoardHandler, 'OK'];
      button2 = ['', 'Cancel'];
      var showIcons = true;
    }
    Dialogs.showFixedDialog({type: headerTitle, title: bodyTitle, msg: bodyText, btnFailure: button2, btnSuccess: button1, icons: showIcons});
  }
  else if(settings.multiboardToggle)
    newGame(true, category);
}

/**
 * Creates a new (empty) game.
 * @param createNewBoard If false, will clear the move-list of the existing game and start over. If true
 * will open a new board when in multiboard mode.
 * @param category The category (variant) for the new game
 * @param fen The starting position for the new game (used for Chess960)
 * @param chess960idn Alternatively the starting IDN for Chess960
 */
function newGame(createNewBoard: boolean, category: string = 'untimed', fen?: string, chess960idn?: string): Game {
  if(createNewBoard)
    var game = createGame();
  else {
    var game = games.focused;
    cleanupGame(game);
  }

  if(category === 'wild/fr' && !fen)
    var fen = ChessHelper.generateChess960FEN(chess960idn ? +chess960idn : null);

  if(!fen)
    fen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

  var data = {
    fen: fen,                               // game state
    turn: 'w',                              // color whose turn it is to move ("B" or "W")
    id: null,                               // The game number
    wname: '',                              // White's name
    bname: '',                              // Black's name
    wrating: '',                            // White's rating
    brating: '',                            // Black's rating
    role: Role.NONE,                        // my relation to this game
    time: 0,                                // initial time in seconds
    inc: 0,                                 // increment per move in seconds
    wtime: 0,                               // White's remaining time
    btime: 0,                               // Black's remaining time
    moveNo: 1,                              // the number of the move about to be made
    move: 'none',                           // pretty notation for the previous move ("none" if there is none)
    flip: false,                            // whether game starts with board flipped
    category: category,                     // game variant or type
  }
  Object.assign(game, data);
  game.statusElement.find('.game-status').html('');
  gameStart(game);

  return game;
};

/** Triggered when the 'Open Games' modal is shown */
$('#open-games-modal').on('show.bs.modal', function() {
  $('#add-games-input').val('');
});

/**
 * Triggered when user clicks 'Open Files(s)' button from Open Games modal.
 * Displays an Open File(s) dialog. Then after user selects PGN file(s) to open, displays
 * a dialog asking if they want to overwrite current gmae or open new board.
 */
$('#open-files').on('click', (event) => {
  // Create file selector dialog
  var fileInput = $('<input type="file" style="display: none" multiple/>');
  fileInput.appendTo('body');
  fileInput.trigger('click');

  fileInput.one('change', async function(event) {
    $('#open-games-modal').modal('hide');
    fileInput.remove();
    const target = event.target as HTMLInputElement;
    var gameFileStrings = await openGameFiles(target.files);
    openGamesOverwriteDialog(gameFileStrings);
  });
});

$('#add-games-button').on('click', (event) => {
  var inputStr = $('#add-games-input').val() as string;
  inputStr = inputStr.trim();
  if(inputStr) {
    $('#open-games-modal').modal('hide');
    openGamesOverwriteDialog([inputStr]);
  }
});

/**
 * When opening PGN file(s), hows a dialog asking if the user wants to Overwrite the
 * current game or open a New Board.
 *
 * @param fileStrings an array of strings representing each opened PGN file (or the Add Games textarea)
 */
function openGamesOverwriteDialog(fileStrings: string[]) {
  var bodyText = '';
  var game = games.focused;

  var overwriteHandler = function(event) {
    parseGameFiles(game, fileStrings, false);
  };

  var newBoardHandler = function(event) {
    parseGameFiles(game, fileStrings, true);
  };

  var button1: any, button2: any;
  if(games.focused.role === Role.NONE) {
    if(games.focused.history.length()) {
      var headerTitle = 'Open Games';
      var bodyTitle = '';
      if(games.focused.role === Role.NONE && settings.multiboardToggle) {
        var bodyText = `${bodyText}Overwrite existing game or open new board?`;
        button1 = [overwriteHandler, 'Overwrite'];
        button2 = [newBoardHandler, 'New Board'];
        var showIcons = false;
      }
      else if(games.focused.role === Role.NONE) {
        var bodyText = `${bodyText}This will clear the current game.`;
        button1 = [overwriteHandler, 'OK'];
        button2 = ['', 'Cancel'];
        var showIcons = true;
      }
      Dialogs.showFixedDialog({type: headerTitle, title: bodyTitle, msg: bodyText, btnFailure: button2, btnSuccess: button1, icons: showIcons});
    }
    else
      parseGameFiles(game, fileStrings, false);
  }
  else if(settings.multiboardToggle)
    parseGameFiles(game, fileStrings, true);
}

/**
 * Open the given files and store their contents in strings
 * @param files FileList object
 */
async function openGameFiles(files: any): Promise<string[]> {
  var fileStrings = [];

  // Wait for all selected files to be read before displaying the first game
  for(const file of Array.from<File>(files)) {
    var readFile = async function(): Promise<string> {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = async function(e) {
          const fileContent = e.target?.result as string;
          resolve(fileContent);
        };
        reader.onerror = function(e) {
          const error = e.target?.error;
          let errorMessage = 'An unknown error occurred';
          if(error)
            errorMessage = `${error.name} - ${error.message}`;
          Dialogs.showFixedDialog({type: 'Failed to open game file', msg: errorMessage, btnSuccess: ['', 'OK']});
          reject(error);
        };
        reader.readAsText(file);
      });
    };
    var fileStr = await readFile();
    if(fileStr)
      fileStrings.push(fileStr);
  }

  return fileStrings;
}

/**
 * Creates a new Game object and loads the games from the given PGN/FEN file strings into it.
 * Each game from the string is stored as a separate History object in game.historyList.
 * For PGNs with multiple games, only the first game is fully parsed. The rest are lazy loaded,
 * i.e. only the PGN metatags are parsed whereas the moves are simply stored as a string in history.pgn
 * and parsed when the game is selected from the game list. PGNs are parsed using @mliebelt/pgn-parser
 * For each file string containing one or more PGN games or FEN lines, splits up the games and creates a History
 * object for each one. Then parses the metatags for each game.
 *
 * @param createNewBoard If false, overwrites existing game, otherwise opens new board when in multiboard mode
 */
async function parseGameFiles(game: Game, gameFileStrings: string[], createNewBoard: boolean = false) {
  var game = newGame(createNewBoard);

  for(let gameStr of gameFileStrings) {
    var regex = /(((?:\s*\[[^\]]+\]\s+)+)([^\[]+?(?=\n\s*(?:[\w]+\/){7}[\w-]+|\[|$))|\s*(?:[\w]+\/){7}[^\n]+)/g; // Splits up the PGN games or FENs in the string (yes there is probably a less ghastly way to do this than a big regex)
    var match;
    var chunkSize = 200;
    var done = false;
    var fenCount = 1;
    while(!done) {
      // Parse games in chunks so as not to tie up the event loop
      await new Promise<void>(resolve => {
        setTimeout(() => {
          for(let i = 0; i < chunkSize; i++) {
            if((match = regex.exec(gameStr)) === null) {
              done = true;
              break;
            }
            if(match.length > 3 && match[2] && match[3]) { // match is a PGN
              var history = new History(game);
              history.pgn = match[3];
              var metatags = parsePGNMetadata(match[2]);
              if(metatags) {
                history.setMetatags(metatags, true);
                game.historyList.push(history);
              }
            }
            else { // match is a FEN
              var fen = match[1].trim();
              var err = ChessHelper.validateFEN(fen);
              if(!err) {
                var history = new History(game, fen);
                history.setMetatags({Event: `FEN ${fenCount}`});
                game.historyList.push(history);
                fenCount++;
              }
              else {
                Dialogs.showFixedDialog({type: 'Invalid FEN', msg: err, btnSuccess: ['', 'OK']});
                return;
              }
            }
          }
          resolve();
        }, 0);
      });
    }
  }

  if(game.historyList.length) {
    updateGamePreserved(game, true);
    setCurrentHistory(game, 0); // Display the first game from the PGN file(s)
  }
}

/**
 * Parse a string of PGN metatags
 */
 function parsePGNMetadata(pgnStr: string) {
  try {
    var pgn = PgnParser.parse(pgnStr, {startRule: "tags"}) as PgnParser.ParseTree;
  }
  catch(err) {
    Dialogs.showFixedDialog({type: 'Failed to parse PGN', msg: err.message, btnSuccess: ['', 'OK']});
    return;
  }
  return pgn.tags;
}

/**
 * Parse a string containing a PGN move list
 */
async function parsePGNMoves(game: Game, pgnStr: string) {
  try {
    var pgn = PgnParser.parse(pgnStr, {startRule: "pgn"}) as PgnParser.ParseTree;
  }
  catch(err) {
    Dialogs.showFixedDialog({type: 'Failed to parse PGN', msg: err.message, btnSuccess: ['', 'OK']});
    return;
  }

  parsePGNVariation(game, pgn.moves);
  game.history.goto(game.history.first());
}

/**
 * Imports a list of moves (and all subvariations recursively) from a @mliebelt/pgn-parser object
 * and puts them in the provided Game's History object
 */
function parsePGNVariation(game: Game, variation: any) {
  var prevHEntry = game.history.current();
  var newSubvariation = !!prevHEntry.next;

  for(let move of variation) {
    var parsedMove = parseGameMove(game, prevHEntry.fen, move.notation.notation);
    if(!parsedMove)
      break;

    if(newSubvariation && prevHEntry.next && prevHEntry.next.fen === parsedMove.fen) {
      prevHEntry = prevHEntry.next;
      continue;
    }

    var currHEntry = game.history.add(parsedMove.move, parsedMove.fen, newSubvariation);
    game.history.setCommentBefore(currHEntry, move.commentMove);
    game.history.setCommentAfter(currHEntry, move.commentAfter);
    if(move.nag)
      move.nag.forEach((nag) => game.history.setAnnotation(currHEntry, nag));
    getOpening(game);
    updateGameVariantMoveData(game);
    newSubvariation = false;

    for(let subvariation of move.variations) {
      game.history.editMode = true;
      game.history.goto(prevHEntry);
      parsePGNVariation(game, subvariation);
    }
    game.history.goto(currHEntry);
    prevHEntry = currHEntry;
  }
}

/**
 * Displays the specified History by building its HTML move list / move table. E.g. when a game
 * is selected from the game list after being loaded from a PGN. If this is the first time a History has
 * been displayed, this will first parse the PGN move list.
 */
function setCurrentHistory(game: Game, historyIndex: number) {
  game.history = game.historyList[historyIndex];
  $('#game-list-button > .label').text(getGameListDescription(game.history, false));
  game.moveTableElement.empty();
  game.moveListElement.empty();
  game.statusElement.find('.game-status').html('');
  updateGameFromMetatags(game);

  if(game.history.pgn) { // lazy load game
    var tags = game.history.metatags;
    if(tags.SetUp === '1' && tags.FEN)
      game.history.first().fen = tags.FEN;
    parsePGNMoves(game, game.history.pgn);
    game.history.pgn = null;
  }
  else
    game.history.addAllMoveElements();
  initGameControls(game);
  game.history.display();
  if(game.isExamining())
    setupGameInExamineMode(game);
}

/**
 * Sets a Game object's data based on the PGN metatags in its History, e.g. set game.wname from metatags.White
 */
function updateGameFromMetatags(game: Game) {
  if(game.role === Role.NONE || game.isExamining()) { // Don't allow user to change the game's attributes while the game is in progress
    var metatags = game.history.metatags;
    var whiteName = metatags.White.slice(0, 17).trim().replace(/[^\w]+/g, '_'); // Convert multi-word names into a single word format that FICS can handle
    var blackName = metatags.Black.slice(0, 17).trim().replace(/[^\w]+/g, '_');
    var whiteStatus = game.element.find(game.color === 'w' ? '.player-status' : '.opponent-status');
    var blackStatus = game.element.find(game.color === 'b' ? '.player-status' : '.opponent-status');
    if(whiteName !== game.wname) {
      game.wname = whiteName;
      if(game.isExamining())
        session.send(`wname ${whiteName}`);
      whiteStatus.find('.name').text(metatags.White);
    }
    if(blackName !== game.bname) {
      game.bname = blackName;
      if(game.isExamining())
        session.send(`bname ${blackName}`);
      blackStatus.find('.name').text(metatags.Black);
    }

    var whiteElo = metatags.WhiteElo;
    if(whiteElo && whiteElo !== '0' && whiteElo !== '-' && whiteElo !== '?')
      game.wrating = whiteElo;
    else
      game.wrating = '';
    whiteStatus.find('.rating').text(game.wrating);

    var blackElo = metatags.BlackElo;
    if(blackElo && blackElo !== '0' && blackElo !== '-' && blackElo !== '?')
      game.brating = blackElo;
    else
      game.brating = '';
    blackStatus.find('.rating').text(game.brating);

    var supportedVariants = ['losers', 'suicide', 'crazyhouse', 'bughouse', 'atomic', 'chess960',
      'blitz', 'lightning', 'untimed', 'standard', 'nonstandard'];
    var variant = metatags.Variant?.toLowerCase();
    if(variant && (supportedVariants.includes(variant) || variant.startsWith('wild'))) {
      if(variant === 'chess960')
        game.category = 'wild/fr';
      else
        game.category = variant;
    }
    else
      game.category = 'untimed';

    // Set the status panel text
    if(!game.statusElement.find('.game-status').html()) {
      if(!metatags.White && !metatags.Black)
        var status = '';
      else {
        var status = `${metatags.White || 'Unknown'} (${metatags.WhiteElo || '?'}) `
            + `${metatags.Black || 'Unknown'} (${metatags.BlackElo || '?'})`
            + `${metatags.Variant ? ` ${metatags.Variant}` : ''}`;

        if(metatags.TimeControl) {
          if(metatags.TimeControl === '-')
            status += ' untimed';
          else {
            var match = metatags.TimeControl.match(/^(\d+)(?:\+(\d+))?$/);
            if(match)
              status += ` ${+match[1] / 60} ${match[2] || '0'}`;
          }
        }
      }

      game.statusElement.find('.game-status').text(status);
    }
  }
}

/**
 * Display the game list when game list dropdown button clicked. The game list button is displayed when
 * multiple games are opened from PGN(s) at once.
 */
$('#game-list-button').on('show.bs.dropdown', function(event) {
  var game = games.focused;
  if(game.historyList.length > 1) {
    $('#game-list-filter').val(game.gameListFilter);
    addGameListItems(game);
  }
});

/**
 * Filters the game list with the text in the filter input. Uses a debounce function to delay
 * updating the list, so that it doesn't update every time a character is typed, which would
 * be performance intensive
 */
var gameListFilterHandler = Utils.debounce((event) => {
  var game = games.focused;
  game.gameListFilter = $(event.target).val() as string;
  addGameListItems(game);
}, 500);
$('#game-list-filter').on('input', gameListFilterHandler);

/**
 * Create the game list dropdown
 */
function addGameListItems(game: Game) {
  $('#game-list-menu').remove();
  var listElements = '';
  for(let i = 0; i < game.historyList.length; i++) {
    var h = game.historyList[i];
    var description = getGameListDescription(h, true);
    if(description.toLowerCase().includes(game.gameListFilter.toLowerCase()))
      listElements += `<li style="width: max-content;" class="game-list-item"><a class="dropdown-item" data-index="${i}">${description}</a></li>`
  }
  $('#game-list-dropdown').append(`<ul id="game-list-menu">${listElements}</ul>`);
}

/**
 * Get the text to be displayed for an item in the game list or in the game list dropdown button
 * @param longDescription the long description is used in the list itself, the short version is used
 * in the dropdown button text
 */
function getGameListDescription(history: History, longDescription: boolean = false) {
  var tags = history.metatags;

  if(/FEN \d+/.test(tags.Event)) {
    var description = tags.Event;
    if(longDescription)
      description += `, ${history.first().fen}`;
    return description;
  }

  var dateTimeStr = (tags.Date || tags.UTCDate || '');
  if(tags.Time || tags.UTCTime)
    dateTimeStr += `${tags.Date || tags.UTCDate ? ' - ' : ''}${tags.Time || tags.UTCTime}`;

  if(tags.White || tags.Black) {
    var description = tags.White || 'unknown';
    if(tags.WhiteElo && tags.WhiteElo !== '0' && tags.WhiteElo !== '-' && tags.WhiteElo !== '?')
      description += ` (${tags.WhiteElo})`;
    description += ` - ${tags.Black || 'unknown'}`;
    if(tags.BlackElo && tags.BlackElo !== '0' && tags.BlackElo !== '-' && tags.BlackElo !== '?')
      description += ` (${tags.BlackElo})`;
    if(tags.Result)
      description += ` [${tags.Result}]`;
  }
  else {
    description = tags.Event || 'Analysis';
    if(!longDescription)
      description += ` ${dateTimeStr}`;
  }

  if(longDescription) {
    if(dateTimeStr)
      description += `, ${dateTimeStr}`;
    if(tags.ECO || tags.Opening || tags.Variation || tags.SubVariation) {
      description += ',';
      if(tags.ECO)
        description += ` [${tags.ECO}]`;
      if(tags.Opening)
        description += ` ${tags.Opening}`;
      else if(tags.Variation)
        description += ` ${tags.Variation}${tags.SubVariation ? `: ${tags.SubVariation}` : ''}`;
    }
  }

  return description;
}

/**
 * Clear the game list after it's closed, since it can take up a lot of memory, e.g. if it contains
 * 10000s of games. In future this should probably be displayed using a virtual scrolling library
 */
$('#game-list-button').on('hidden.bs.dropdown', function(event) {
  $('#game-list-menu').html('');
});

/** Triggered when a game is selected from the game list */
$('#game-list-dropdown').on('click', '.dropdown-item', (event) => {
  var index = +$(event.target).attr('data-index');
  setCurrentHistory(games.focused, index);
});

$('#save-game-modal').on('show.bs.modal', function() {
  var fenOutput = $('#save-fen-output');
  fenOutput.val('');
  fenOutput.val(games.focused.history.current().fen);

  var pgn = gameToPGN(games.focused);
  var pgnOutput = $('#save-pgn-output');
  pgnOutput.val('');
  pgnOutput.val(pgn);

  var numRows = 1;
  for(let i = 0; i < pgn.length; i++) {
    if(pgn[i] === '\n')
      numRows++;
  }
  pgnOutput.css('padding-right', '');
  if(numRows > +pgnOutput.attr('rows')) {
    var scrollbarWidth = Utils.getScrollbarWidth();
    var padding = pgnOutput.css('padding-right');
    pgnOutput.css('padding-right', `calc(${padding} + ${scrollbarWidth}px)`);
    $('#save-pgn-copy').css('right', `${scrollbarWidth}px`);
  }
});

/** Triggered when user clicks the FEN 'copy to clipboard' button in the 'Save Game' modal */
$('#save-fen-copy').on('click', (event) => {
  Utils.copyToClipboard($('#save-fen-output'), $(event.currentTarget));
});

/** Triggered when user clicks the PGN 'copy to clipboard' button in the 'Save Game' modal */
$('#save-pgn-copy').on('click', (event) => {
  Utils.copyToClipboard($('#save-pgn-output'), $(event.currentTarget));
});

/**
 * Takes a game object and returns the game in PGN format
 */
function gameToPGN(game: Game): string {
  var movesStr = Utils.breakAtMaxLength(game.history.movesToString(), 80);
  return `${game.history.metatagsToString()}\n\n${movesStr ? `${movesStr} ` : ''}${game.history.metatags.Result}`;
}

/** Triggered when 'Save PGN' menu option is selected */
$('#save-pgn-button').on('click', (event) => {
  savePGN(games.focused, $('#save-pgn-output').val() as string);
});

/**
 * Saves game to a .pgn file
 */
function savePGN(game: Game, pgn: string) {
  // Construct file name
  var metatags = game.history.metatags;
  var wname = metatags.White;
  var bname = metatags.Black;
  var event = metatags.Event;
  var date = metatags.Date;
  var time = metatags.Time;
  if(date) {
    date = date.replace(/\./g, '-');
    var match = date.match(/^\d+(-\d+)?(-\d+)?/);
    date = (match ? match[0] : null);
  }
  if(time) {
    time = time.replace(/:/g, '.');
    match = time.match(/^\d+(.\d+)?(.\d+)?/);
    time = (match ? match[0] : null);
  }

  if(wname || bname)
    var filename = `${wname || 'unknown'}_vs_${bname || 'unknown'}${date ? `_${date}` : ''}${time ? `_${time}` : ''}.pgn`;
  else {
    event = event.replace(/^FEN (\d+)$/, 'Analysis-$1');
    var filename = `${event || 'Analysis'}${date ? `_${date}` : ''}${time ? `_${time}` : ''}.pgn`;
  }

  // Save file
  const data = new Blob([pgn], { type: 'text/plain' });
  const url = window.URL.createObjectURL(data);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  window.URL.revokeObjectURL(url);
}

/** Triggered when the 'Duplicate Game' menu option is selected */
$('#game-tools-clone').on('click', (event) => {
  cloneGame(games.focused);
});

/**
 * Make an exact copy of a game with its own board, move list and status panels.
 * The clone will not be in examine or observe mode, regardless of the original.
*/
function cloneGame(game: Game): Game {
  var clonedGame = createGame();

  // Copy GameData properties
  var gameData = new GameData(); // Create temp instance in order to iterate its proeprties
  for(const key of Object.keys(gameData))
    clonedGame[key] = game[key];

  clonedGame.id = null;
  clonedGame.role = Role.NONE;
  clonedGame.history = game.history.clone(clonedGame);
  clonedGame.history.display();
  clonedGame.statusElement.find('.game-watchers').empty();
  clonedGame.statusElement.find('.game-id').remove();
  clonedGame.element.find('.title-bar-text').empty();

  clonedGame.board.set({ orientation: game.board.state.orientation });
  scrollToBoard(clonedGame);
  return clonedGame;
}

/** Triggered when the 'Examine Mode (Shared)' menu option is selected */
$('#game-tools-examine').on('click', (event) => {
  examineModeRequested = games.focused;
  var mainGame = games.getPlayingExaminingGame();
  if(mainGame && mainGame.isExamining())
    session.send('unex');
  session.send('ex');
});

/**
 * Convert a game to examine mode by using bsetup and then commiting the movelist
 */
function setupGameInExamineMode(game: Game) {
  /** Setup the board */
  if(game.setupBoard)
    var fen: string = getSetupBoardFEN(game);
  else
    var fen: string  = game.history.first().fen;

  var fenWords = ChessHelper.splitFEN(fen);

  game.commitingMovelist = true;

  // starting FEN
  session.send(`bsetup fen ${fenWords.board}`);

  // game rules
  // Note bsetup for fr and wild are currently broken on FICS and there is no option for bughouse
  if(game.category === 'wild/fr')
    session.send('bsetup fr');
  else if(game.category.startsWith('wild'))
    session.send('bsetup wild');
  else if(game.category === 'losers' || game.category === 'crazyhouse' || game.category === 'atomic' || game.category === 'suicide')
    session.send(`bsetup ${game.category}`);

  // turn color
  session.send(`bsetup tomove ${fenWords.color === 'w' ? 'white' : 'black'}`);

  // castling rights
  var castlingRights = fenWords.castlingRights;
  sendWhiteCastlingRights(castlingRights);
  sendBlackCastlingRights(castlingRights);

  // en passant rights
  var enPassant = fenWords.enPassant;
  if(enPassant !== '-')
    session.send(`bsetup eppos ${enPassant[0]}`);

  session.send(`wname ${game.wname}`);
  session.send(`bname ${game.bname}`);

  if(!game.setupBoard) {
    session.send('bsetup done');

    // Send and commit move list
    if(game.history.current() !== game.history.last())
      var currMove = game.history.current();
    game.history.goto(game.history.first());
    var hEntry = game.history.first();
    while(hEntry) {
      if(hEntry.move)
        sendMove(hEntry.move);
      session.send(`wclock ${Clock.MSToHHMMSS(hEntry.wtime)}`);
      session.send(`bclock ${Clock.MSToHHMMSS(hEntry.btime)}`);
      var hEntry = hEntry.next;
    }
    if(!game.history.scratch() && game.history.length())
      session.send('commit');
    game.history.goto(game.history.last());

    // Navigate back to current move
    if(currMove) {
      gotoMove(currMove);
      game.history.goto(currMove);
    }
  }

  // This is a hack just to indicate we are done
  session.send('done');

  if(!game.statusElement.find('.game-status').html()) {
    game.gameStatusRequested = true;
    session.send(`moves ${game.id}`);
  }
}

/**
 * In 'bsetup' mode, sends white's castling rights to the server.
 * @param castlingRights castling rights string in typical FEN format e.g. 'KQkq'
 */
function sendWhiteCastlingRights(castlingRights: string) {
  if(castlingRights.includes('K') && castlingRights.includes('Q'))
    var wcastling = 'both';
  else if(castlingRights.includes('K'))
    var wcastling = 'kside';
  else if(castlingRights.includes('Q'))
    var wcastling = 'qside';
  else
    var wcastling = 'none';
  session.send(`bsetup wcastle ${wcastling}`);
}

/**
 * In 'bsetup' mode, sends black's castling rights to the server.
 * @param castlingRights castling rights string in typical FEN format e.g. 'KQkq'
 */
function sendBlackCastlingRights(castlingRights: string) {
  if(castlingRights.includes('k') && castlingRights.includes('q'))
    var bcastling = 'both';
  else if(castlingRights.includes('k'))
    var bcastling = 'kside';
  else if(castlingRights.includes('q'))
    var bcastling = 'qside';
  else
    var bcastling = 'none';
  session.send(`bsetup bcastle ${bcastling}`);
}

/******************************
 * SETUP BOARD MODE FUNCTIONS *
 ******************************/

/** Triggered when 'Setup Board' menu option is selected */
$('#game-tools-setup-board').on('click', (event) => {
  setupBoard(games.focused);
  scrollToBoard();
});

/**
 * Enters setup board mode.
 * @param serverIssued True if someone (us or another examiner) sent the 'bsetup' command, false if we are entering
 * setup mode via the Game Tools menu.
 */
function setupBoard(game: Game, serverIssued: boolean = false) {
  game.setupBoard = true;
  game.element.find('.status').hide(); // Hide the regular player status panels
  if(game.isExamining() && !serverIssued)
    session.send('bsetup');
  updateSetupBoard(game);
  // Display the Setup Board panels above and below the chess board
  game.element.find('.setup-board-top').css('display', 'flex');
  game.element.find('.setup-board-bottom').css('display', 'flex');
  showPanel('#left-panel-setup-board'); // Show the left panel for leaving/cancelling setup mode
  initGameTools(game);
  updateBoard(game, false, false);
}

function leaveSetupBoard(game: Game, serverIssued: boolean = false) {
  game.setupBoard = false;
  game.element.find('.setup-board-top').hide();
  game.element.find('.setup-board-bottom').hide();
  game.element.find('.status').css('display', 'flex');
  hidePanel('#left-panel-setup-board');
  initGameTools(game);
  updateBoard(game);
  if(game.isExamining() && !serverIssued)
    session.send('bsetup done');
}

/**
 * In setup board mode, initializes or updates the board and setup board controls based on the given FEN.
 * Or if no fen is specified, uses the current move in the move list.
 * @param serverIssued True if the new FEN was received from the server (for example from another examiner).
 * False if the new FEN is a result of the user moving a piece on the board etc.
 */
function updateSetupBoard(game: Game, fen?: string, serverIssued: boolean = false) {
  var oldFen = getSetupBoardFEN(game);

  if(!fen)
    fen = game.history.current().fen;

  game.fen = fen; // Since setup mode doesn't use the move list, we store the current position in game.fen
  if(fen === oldFen)
    return;

  var fenWords = ChessHelper.splitFEN(fen);
  if(ChessHelper.splitFEN(oldFen).board !== fenWords.board) {
    game.board.set({ fen });
    if(game.isExamining() && !serverIssued)
      session.send(`bsetup fen ${fenWords.board}`); // Transmit the board position to the server when in examine mode
  }

  setupBoardColorToMove(game, fenWords.color, serverIssued); // Update the color to move control
  setupBoardCastlingRights(game, fenWords.castlingRights, serverIssued); // Update the castling rights controls
  updateEngine(); // If the engine is running, analyze the current position shown on the board
}

/**
 * Triggered when the user clicks the 'Reset Board' button when in Setup Board mode.
 * Resets the board to the first move in the move list
 */
$(document).on('click', '.reset-board', (event) => {
  var game = games.focused;
  var fen = games.focused.history.first().fen;
  if(fen === '8/8/8/8/8/8/8/8 w - - 0 1') // No initial position because user sent 'bsetup' without first examining a game
    fen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  updateSetupBoard(games.focused, fen);
});

/** Triggered when the user clicks the 'Clear Board' button when in Setup Board mode. */
$(document).on('click', '.clear-board', (event) => {
  updateSetupBoard(games.focused, '8/8/8/8/8/8/8/8 w - - 0 1');
});

/** Triggered when user checks/unchecks the castling rights controls in Setup Board mode */
$(document).on('change', '.can-kingside-castle-white, .can-queenside-castle-white, .can-kingside-castle-black, .can-queenside-castle-black', (event) => {
  var game = games.focused;
  var castlingRights = ChessHelper.splitFEN(getSetupBoardFEN(game)).castlingRights;
  if(game.isExamining()) {
    if($(event.target).hasClass('can-queenside-castle-white') || $(event.target).hasClass('can-kingside-castle-white'))
      sendWhiteCastlingRights(castlingRights);
    else
      sendBlackCastlingRights(castlingRights);
  }
  game.fen = getSetupBoardFEN(game);
  updateEngine();
});

/** Sets the color to move using the Setup Board dropdown button */
(window as any).setupBoardColorToMove = (color: string) => {
  var game = games.focused;
  setupBoardColorToMove(game, color);
  game.fen = getSetupBoardFEN(game);
  updateEngine();
};
function setupBoardColorToMove(game: Game, color: string, serverIssued: boolean = false) {
  var oldColor = ChessHelper.splitFEN(getSetupBoardFEN(game)).color;

  var colorName = (color === 'w' ? 'White' : 'Black');
  if(Utils.isSmallWindow())
    var label = `${colorName}'s move`;
  else
    var label = `${colorName} to move`;

  var button = game.element.find('.color-to-move-button');
  button.text(label);
  button.attr('data-color', color);

  if(game.isExamining() && !serverIssued && oldColor !== color)
    session.send(`bsetup tomove ${colorName}`);
}

function setupBoardCastlingRights(game: Game, castlingRights: string, serverIssued: boolean = false) {
  var oldCastlingRights = ChessHelper.splitFEN(getSetupBoardFEN(game)).castlingRights;

  game.element.find('.can-kingside-castle-white').prop('checked', castlingRights.includes('K'));
  game.element.find('.can-queenside-castle-white').prop('checked', castlingRights.includes('Q'));
  game.element.find('.can-kingside-castle-black').prop('checked', castlingRights.includes('k'));
  game.element.find('.can-queenside-castle-black').prop('checked', castlingRights.includes('q'));

  if(game.isExamining() && !serverIssued) {
    if(oldCastlingRights.includes('K') !== castlingRights.includes('K')
        || oldCastlingRights.includes('Q') !== castlingRights.includes('Q'))
      sendWhiteCastlingRights(castlingRights);
    if(oldCastlingRights.includes('k') !== castlingRights.includes('k')
        || oldCastlingRights.includes('q') !== castlingRights.includes('q'))
      sendBlackCastlingRights(castlingRights);
  }
}

document.addEventListener('touchstart', dragSetupBoardPiece, {passive: false});
document.addEventListener('mousedown', dragSetupBoardPiece);
function dragSetupBoardPiece(event: any) {
  if(!$(event.target).hasClass('setup-board-piece'))
    return;
  dragPiece(event);
}

/** Triggered when user clicks the 'Setup Done' button */
$('#setup-done').on('click', (event) => {
  setupDone(games.focused);
});

/**
 * Leave setup board mode and reset the move list with the current board position as the starting position
 */
function setupDone(game: Game) {
  var fen = getSetupBoardFEN(game);

  var err = ChessHelper.validateFEN(fen, game.category);
  if(err) {
    Dialogs.showFixedDialog({type: 'Invalid Position', msg: err, btnSuccess: ['', 'OK']});
    return;
  }

  game.history.reset(fen);
  $('#game-pane-status').hide();
  leaveSetupBoard(game);
}

/** Triggered when user clicks the 'Cancel Setup' button */
$('#cancel-setup').on('click', (event) => {
  cancelSetup(games.focused);
});

/**
 * Leave setup board mode and return to the current move in the move list.
 */
function cancelSetup(game: Game) {
  if(game.isExamining())
    session.send('bsetup start'); // Reset board so that it passes validation when sending 'bsetup done'
  leaveSetupBoard(game);
  // FICS doesn't have a 'bsetup cancel' command, so in order to cancel the setup we need to manually
  // reconstruct the move list (on the server), from before 'bsetup' was entered.
  if(game.isExamining())
    setupGameInExamineMode(game);
}

/**
 * On mobile the buttons for 'Setup Done' and 'Cancel Setup' are shown in a panel just above the board.
 * Whereas on desktop, they are shown in the top left just below the navigation buttons.
 */
function moveLeftPanelSetupBoard() {
  var setupBoardPanel = $('#left-panel-setup-board');
  if(Utils.isSmallWindow()) {
    setupBoardPanel.removeClass('card-header');
    setupBoardPanel.addClass('card-footer');
    setupBoardPanel.removeClass('top-panel');
    setupBoardPanel.addClass('bottom-panel');
    $('#left-panel-footer').after(setupBoardPanel);
  }
  else {
    setupBoardPanel.removeClass('card-footer');
    setupBoardPanel.addClass('card-header');
    setupBoardPanel.removeClass('bottom-panel');
    setupBoardPanel.addClass('top-panel');
    $('#left-panel-header-2').before(setupBoardPanel);
  }
}

/**
 * In setup board mode, return a FEN generated from the current board position, color to move
 * and castling rights controls.
 */
function getSetupBoardFEN(game: Game): string {
  var colorToMove = game.element.find('.color-to-move-button').attr('data-color');
  var wK = (game.element.find('.can-kingside-castle-white').is(':checked') ? 'K' : '');
  var wQ = (game.element.find('.can-queenside-castle-white').is(':checked') ? 'Q' : '');
  var bK = (game.element.find('.can-kingside-castle-black').is(':checked') ? 'k' : '');
  var bQ = (game.element.find('.can-queenside-castle-black').is(':checked') ? 'q' : '');
  var castlingRights = `${wK}${wQ}${bK}${bQ}`;
  if(!castlingRights)
    castlingRights = '-';
  return `${game.board.getFen()} ${colorToMove} ${castlingRights} - 0 1`;
}

/**
 * Triggered when the 'Game Properties' menu item is selected.
 * Displays the PGN metatags associated with the game which can then be modified.
 * The game state is updated to reflect the modified metatags.
 */
$('#game-tools-properties').on('click', (event) => {
  var okHandler = function(event) {
    var metatagsStr = this.closest('.toast').querySelector('.game-properties-input').value;
    try {
      var pgn = PgnParser.parse(metatagsStr, {startRule: "tags"}) as PgnParser.ParseTree;
    }
    catch(err) {
      Dialogs.showFixedDialog({type: 'Failed to update properties', msg: err.message, btnSuccess: ['', 'OK']});
      return;
    }
    games.focused.history.setMetatags(pgn.tags, true);
    updateGameFromMetatags(games.focused);
  };

  var headerTitle = 'Game Properties';
  var bodyText = `<textarea style="resize: none" class="form-control game-properties-input" rows="10" type="text" `
      + `autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false">`
      + `${games.focused.history.metatagsToString()}</textarea>`;
  var button1 = [okHandler, 'Keep Changes'];
  var button2 = ['', 'Cancel'];
  Dialogs.showFixedDialog({type: headerTitle, msg: bodyText, btnFailure: button2, btnSuccess: button1, htmlMsg: true});
});

/**
 * Triggered when the 'Close Game' menu item is selected.
 * Closes the game.
 */
$('#game-tools-close').on('click', (event) => {
  var game = games.focused;
  if(game.preserved || game.history.editMode)
    closeGameDialog(game);
  else
    closeGame(game);
});

/*************************************
 * STATUS / ANALYSIS PANEL FUNCTIONS *
 *************************************/

function initStatusPanel() {
  if(games.focused.isPlaying()) {
    $('#close-status').hide();
    hideAnalysis();
  }
  else if($('#left-panel-bottom').is(':visible')) {
    if(games.focused.analyzing)
      showAnalysis();
    else
      hideAnalysis();

    showAnalyzeButton();
    if($('#engine-tab').is(':visible') && evalEngine)
      evalEngine.evaluate();
    $('#close-status').show();
  }
}

function showStatusPanel() {
  showPanel('#left-panel-bottom');
  initStatusPanel();
}

function hideStatusPanel() {
  $('#show-status-panel').text('Status/Analysis');
  $('#show-status-panel').attr('title', 'Show Status Panel');
  $('#show-status-panel').show();
  stopEngine();
  hidePanel('#left-panel-bottom');
}

/**
 * Scroll to the status/analysis panel
 */
function scrollToLeftPanelBottom() {
  if(Utils.isSmallWindow())
    Utils.safeScrollTo($('#left-panel-bottom').offset().top);
}

$('#left-panel-bottom').on('shown.bs.tab', '.nav-link', (e) => {
  games.focused.currentStatusTab = $(e.target);

  if($(e.target).attr('id') === 'eval-graph-tab') {
    if(!evalEngine)
      createEvalEngine(games.focused);

    if(evalEngine)
      evalEngine.redraw();
  }
});

$('#left-bottom-tabs .closeTab').on('click', (event) => {
  var id = $(event.target).parent().siblings('.nav-link').attr('id');
  if(id === 'engine-tab' || id === 'eval-graph-tab')
    hideAnalysis();
});

function openLeftBottomTab(tab: any) {
  tab.parent().show();
  $('#left-bottom-tabs').css('visibility', 'visible');
  tab.tab('show');
}

function closeLeftBottomTab(tab: any) {
  $('#status-tab').tab('show');
  tab.parent().hide();
  if($('#left-bottom-tabs li:visible').length === 1)
    $('#left-bottom-tabs').css('visibility', 'hidden');
}

function showStatusMsg(game: Game, msg: string) {
  if(game === games.focused)
    showStatusPanel();
  if(msg)
    game.statusElement.find('.game-status').html(msg);
}

async function showOpeningName(game: Game) {
  await fetchOpeningsPromise; // Wait for the openings file to be loaded

  if(!game.history)
    return;

  var hEntry = game.history.current();
  if(!hEntry.move)
    hEntry = game.history.last();

  while(!hEntry.opening) {
    if(!hEntry.move) {
      game.statusElement.find('.opening-name').text('');
      game.statusElement.find('.opening-name').hide();
      return;
    }
    hEntry = hEntry.prev;
  }

  game.statusElement.find('.opening-name').text(hEntry.opening.name);
  game.statusElement.find('.opening-name').show();
}

/** ANALYSIS FUNCTIONS **/

(window as any).analyze = () => {
  showAnalysis();
  showStatusPanel();
  scrollToLeftPanelBottom();
};

function showAnalysis() {
  var game = games.focused;
  var currentStatusTab = game.currentStatusTab;

  openLeftBottomTab($('#engine-tab'));
  openLeftBottomTab($('#eval-graph-tab'));

  $('#engine-pvs').empty();
  for(let i = 0; i < numPVs; i++)
    $('#engine-pvs').append('<li>&nbsp;</li>');
  $('#engine-pvs').css('white-space', (numPVs === 1 ? 'normal' : 'nowrap'));
  games.focused.analyzing = true;

  if(currentStatusTab && currentStatusTab.attr('id') !== 'eval-graph-tab')
    currentStatusTab.tab('show');
}

function hideAnalysis() {
  stopEngine();
  closeLeftBottomTab($('#engine-tab'));
  closeLeftBottomTab($('#eval-graph-tab'));
  showAnalyzeButton();
  games.focused.analyzing = false;
  games.focused.currentStatusTab = null;
}

function initAnalysis(game: Game) {
  // Check if game category (variant) is supported by Engine
  if(game === games.focused) {
    if(evalEngine) {
      evalEngine.terminate();
      evalEngine = null;
    }

    if(game.category) {
      if(Engine.categorySupported(game.category)) {
        if(game.id || game.history.length())
          showAnalyzeButton();
      }
      else
        hideAnalysis();
    }

    if($('#eval-graph-panel').is(':visible'))
      createEvalEngine(game);
  }
}

$('#start-engine').on('click', (event) => {
  if(!engine)
    startEngine();
  else
    stopEngine();
});

function startEngine() {
  var game = games.focused;

  if(Engine.categorySupported(game.category)) {
    $('#start-engine').text('Stop');

    $('#engine-pvs').empty();
    for(let i = 0; i < numPVs; i++)
      $('#engine-pvs').append('<li>&nbsp;</li>');

    var options = {};
    if(numPVs > 1)
      options['MultiPV'] = numPVs;

    // Configure for variants
    if(game.category === 'wild/fr')
      options['UCI_Chess960'] = true;
    else if(game.category === 'crazyhouse')
      options['UCI_Variant'] = game.category;

    engine = new Engine(game, null, displayEnginePV, options);
    if(game.setupBoard)
      engine.evaluateFEN(getSetupBoardFEN(game));
    else if(!game.movelistRequested)
      engine.move(game.history.current());
  }
}

function stopEngine() {
  $('#start-engine').text('Go');

  if(engine) {
    engine.terminate();
    engine = null;
    setTimeout(() => { games.focused.board.setAutoShapes([]); }, 0); // Need timeout to avoid conflict with board.set({orientation: X}); if that occurs in the same message handler
  }
}

function updateEngine() {
  if(engine) {
    stopEngine();
    startEngine();
  }
  if(evalEngine)
    evalEngine.evaluate();
}

$('#add-pv').on('click', (event) => {
  numPVs++;
  $('#engine-pvs').css('white-space', (numPVs === 1 ? 'normal' : 'nowrap'));
  $('#engine-pvs').append('<li>&nbsp;</li>');
  if(engine) {
    stopEngine();
    startEngine();
  }
});

$('#remove-pv').on('click', (event) => {
  if(numPVs == 1)
    return;

  numPVs--;
  $('#engine-pvs').css('white-space', (numPVs === 1 ? 'normal' : 'nowrap'));
  $('#engine-pvs li').last().remove();
  if(engine)
    engine.setNumPVs(numPVs);
});

function displayEnginePV(game: Game, pvNum: number, pvEval: string, pvMoves: string) {
  $('#engine-pvs li').eq(pvNum - 1).html(`<b>(${pvEval})</b> ${pvMoves}<b/>`);

  if(pvNum === 1 && pvMoves) {
    var words = pvMoves.split(/\s+/);
    var san = words[0].split(/\.+/)[1];
    var parsed = parseGameMove(game, game.history.current().fen, san);
    game.board.setAutoShapes([{
      orig: parsed.move.from || parsed.move.to, // For crazyhouse, just draw a circle on dest square
      dest: parsed.move.to,
      brush: 'yellow',
    }]);
  }
}

function createEvalEngine(game: Game) {
  if(game.category && Engine.categorySupported(game.category)) {
    // Configure for variants
    var options = {};
    if(game.category === 'wild/fr')
      options['UCI_Chess960'] = true;
    else if(game.category === 'crazyhouse')
      options['UCI_Variant'] = game.category;

    evalEngine = new EvalEngine(game, options);
  }
}

/** STATUS PANEL SHOW/HIDE BUTTON **/

$('#show-status-panel').on('click', (event) => {
  if($('#show-status-panel').text() === 'Analyze')
    showAnalysis();
  showStatusPanel();
  scrollToLeftPanelBottom();
});

$('#close-status').on('click', (event) => {
  hideStatusPanel();
});

function showAnalyzeButton() {
  if($('#left-panel-bottom').is(':visible')) {
    $('#show-status-panel').text('Analyze');
    $('#show-status-panel').attr('title', 'Analyze Game');
  }

  if(!$('#engine-tab').is(':visible') && Engine.categorySupported(games.focused.category))
    $('#show-status-panel').show();
  else if($('#left-panel-bottom').is(':visible'))
    $('#show-status-panel').hide();
}

/*******************************
/* PLAYING-GAME ACTION BUTTONS *
 *******************************/

$('#resign').on('click', (event) => {
  var game = games.focused;

  if(!game.isPlaying()) {
    showStatusMsg(game, 'You are not playing a game.');
    return;
  }

  if(game.role === Role.PLAYING_COMPUTER) {
    var winner = (game.color === 'w' ? game.bname : game.wname);
    var loser = (game.color === 'w' ? game.wname : game.bname);
    var gameStr = `(${game.wname} vs. ${game.bname})`;
    var reasonStr = `${loser} resigns`;
    var scoreStr = (winner === game.wname ? '1-0' : '0-1');
    var gameEndData = {
      game_id: -1,
      winner,
      loser,
      reason: Reason.Resign,
      score: scoreStr,
      message: `${gameStr} ${reasonStr} ${scoreStr}`
    };
    messageHandler(gameEndData);
  }
  else
    session.send('resign');
});

$('#adjourn').on('click', (event) => {
  session.send('adjourn');
});

$('#abort').on('click', (event) => {
  var game = games.focused;

  if(!game.isPlaying()) {
    showStatusMsg(game, 'You are not playing a game.');
    return;
  }

  if(game.role === Role.PLAYING_COMPUTER) {
    var gameStr = `(${game.wname} vs. ${game.bname})`;
    var reasonStr = 'Game aborted';
    var gameEndData = {
      game_id: -1,
      winner: '',
      loser: '',
      reason: Reason.Abort,
      score: '*',
      message: `${gameStr} ${reasonStr} *`
    };
    messageHandler(gameEndData);
  }
  else
    session.send('abort');
});

$('#takeback').on('click', (event) => {
  var game = games.focused;

  if (game.isPlaying()) {
    if(game.history.last().turnColor === game.color)
      session.send('take 2');
    else
      session.send('take 1');
  } else {
    showStatusMsg(game, 'You are not playing a game.');
  }
});

$('#draw').on('click', (event) => {
  var game = games.focused;

  if(game.isPlaying()) {
    if(game.role === Role.PLAYING_COMPUTER) {
      // Computer accepts a draw if they're behind or it's dead equal and the game is on move 30 or beyond
      var gameEval = game.lastComputerMoveEval;
      if(gameEval === null)
        gameEval = '';
      gameEval = gameEval.replace(/[#+=]/, '');
      if(gameEval !== '' && game.history.length() >= 60 && (game.color === 'w' ? +gameEval >= 0 : +gameEval <= 0)) {
        var gameStr = `(${game.wname} vs. ${game.bname})`;
        var reasonStr = 'Game drawn by mutual agreement';
        var scoreStr = '1/2-1/2';
        var gameEndData = {
          game_id: -1,
          winner: '',
          loser: '',
          reason: Reason.Draw,
          score: scoreStr,
          message: `${gameStr} ${reasonStr} ${scoreStr}`
        };
        messageHandler(gameEndData);
      }
      else
        Dialogs.showBoardDialog({type: 'Draw Offer Declined', msg: 'Computer declines the draw offer'});
    }
    else
      session.send('draw');
  } else {
    showStatusMsg(game, 'You are not playing a game.');
  }
});

/*************************
 * RIGHT PANEL FUNCTIONS *
 *************************/

/** CONNECT BUTTON FUNCTIONS **/

$('#login-form').on('submit', (event) => {
  const user: string = Utils.getValue('#login-user');
  if(session && session.isConnected() && user === session.getUser()) {
    $('#login-user').addClass('is-invalid');
    event.preventDefault();
    return false;
  }
  const pass: string = Utils.getValue('#login-pass');
  if(session)
    session.disconnect();
  session = new Session(messageHandler, user, pass);
  settings.rememberMeToggle = $('#remember-me').prop('checked');
  storage.set('rememberme', String(settings.rememberMeToggle));
  if(settings.rememberMeToggle) 
    credential.set(user, pass);
  else 
    credential.clear();

  $('#login-screen').modal('hide');
  event.preventDefault();
  return false;
});

$('#sign-in').on('click', (event) => {
  $('#login-screen').modal('show');
});

$('#connect-user').on('click', (event) => {
  $('#login-screen').modal('show');
});

$('#login-screen').on('show.bs.modal', async (e) => {
  if(credential.username) 
    $('#login-user').val(credential.username);
  if(credential.password) 
    $('#login-pass').val(credential.password);

  $('#remember-me').prop('checked', settings.rememberMeToggle);

  $('#login-user').removeClass('is-invalid');
});

$('#login-screen').on('hidden.bs.modal', async (e) => {
  $('#login-pass').val(''); // clear the password field when form not visible
});

$('#login-user').on('change', () => {
  $('#login-user').removeClass('is-invalid');
});

/**
 * This detects whether the browser's password manager has autofilled the login/password form when it's
 * invisible. For example, in Firefox after the user enters their Master Password. 
 */ 
$('#login-pass').on('change', () => {
  if(!$('#login-form').is(':visible') && $('#login-pass').val() as string) { 
    if(settings.rememberMeToggle && credential && credential.password == null) {
      credential.set($('#login-user').val() as string, $('#login-pass').val() as string);
      if(session) {
        session.disconnect();
        session = new Session(messageHandler, credential.username, credential.password);
      }
    }
    $('#login-user').val('');
    $('#login-pass').val('');
  }
});

$('#connect-guest').on('click', (event) => {
  if(session)
    session.disconnect();
  session = new Session(messageHandler);
});

$('#login-as-guest').on('click', (event) => {
  if ($('#login-as-guest').is(':checked')) {
    $('#login-user').val('guest');
    $('#login-user').prop('disabled', true);
    $('#login-pass').val('');
    $('#login-pass').prop('disabled', true);
  } else {
    $('#login-user').val('');
    $('#login-user').prop('disabled', false);
    $('#login-pass').val('');
    $('#login-pass').prop('disabled', false);
  }
});

$('#disconnect').on('click', (event) => {
  if (session)
    session.disconnect();
});

/**********************
 * SETTINGS FUNCTIONS *
 **********************/

/**
 * Load in settings from persistent storage and initialize settings controls.
 * This must be done after 'storage' is initialised in onDeviceReady
 */
function initSettings() {
  settings.soundToggle = (storage.get('sound') !== 'false');
  updateDropdownSound();

  settings.autoPromoteToggle = (storage.get('autopromote') === 'true');
  $('#autopromote-toggle').prop('checked', settings.autoPromoteToggle);

  settings.notificationsToggle = (storage.get('notifications') !== 'false');
  $('#notifications-toggle').prop('checked', settings.notificationsToggle);

  settings.highlightsToggle = (storage.get('highlights') !== 'false');
  $('#highlights-toggle').prop('checked', settings.highlightsToggle);

  settings.wakelockToggle = (storage.get('wakelock') !== 'false');
  $('#wakelock-toggle').prop('checked', settings.wakelockToggle);

  settings.multiboardToggle = (storage.get('multiboard') !== 'false');
  $('#multiboard-toggle').prop('checked', settings.multiboardToggle);

  settings.rememberMeToggle = (storage.get('rememberme') === 'true');
  $('#remember-me').prop('checked', settings.rememberMeToggle);

  settings.lobbyShowComputersToggle = (storage.get('lobbyshowcomputers') === 'true');
  settings.lobbyShowUnratedToggle = (storage.get('lobbyshowunrated') !== 'false');

  History.initSettings();
}

$('#flip-toggle').on('click', (event) => {
  flipBoard(games.focused);
});

$('#sound-toggle').on('click', (event) => {
  settings.soundToggle = !settings.soundToggle;
  updateDropdownSound();
  storage.set('sound', String(settings.soundToggle));
});
function updateDropdownSound() {
  const iconClass = `dropdown-icon fa fa-volume-${settings.soundToggle ? 'up' : 'off'}`;
  $('#sound-toggle').html(`<span id="sound-toggle-icon" class="${iconClass}" aria-hidden="false"></span>`
      + `Sounds ${settings.soundToggle ? 'ON' : 'OFF'}`);
}

$('#notifications-toggle').on('click', (event) => {
  settings.notificationsToggle = !settings.notificationsToggle;
  storage.set('notifications', String(settings.notificationsToggle));
});

$('#autopromote-toggle').on('click', (event) => {
  settings.autoPromoteToggle = !settings.autoPromoteToggle;
  storage.set('autopromote', String(settings.autoPromoteToggle));
});

$('#highlights-toggle').on('click', (event) => {
  settings.highlightsToggle = !settings.highlightsToggle;
  updateBoard(games.focused, false, false);
  storage.set('highlights', String(settings.highlightsToggle));
});

$('#wakelock-toggle').on('click', (event) => {
  settings.wakelockToggle = !settings.wakelockToggle;
  if(settings.wakelockToggle)
    noSleep.enable();
  else 
    noSleep.disable();
  storage.set('wakelock', String(settings.wakelockToggle));
});

$('#multiboard-toggle').on('click', (event) => {
  settings.multiboardToggle = !settings.multiboardToggle;
  if(!settings.multiboardToggle) {
    // close all games except one
    var game = games.getMostImportantGame();
    setGameWithFocus(game);
    maximizeGame(game);

    // close all games in the secondary board area
    for(let g of [...games]) {
      if(g.element.parent().is('#secondary-board-area'))
        closeGame(g);
    }
  }
  initGameTools(games.focused);
  storage.set('multiboard', String(settings.multiboardToggle));
});

/********************************
 * CONSOLE/CHAT INPUT FUNCTIONS *
 ********************************/

$('#input-form').on('submit', (event) => {
  event.preventDefault();
  let text;
  let val: string = Utils.getValue('#input-text');
  val = val.replace(/[“‘”]/g, "'");
  val = val.replace(/[^\S ]/g, ' '); // replace other whitespace chars with space
  val = val.replace(/[\x00-\x1F\x7F-\x9F]/g, ''); // Strip out ascii and unicode control chars
  if (val === '' || val === '\n') {
    return;
  }

  const tab = chat.currentTab();
  if(val.charAt(0) === '@')
    text = val.substring(1);
  else if(tab !== 'console') {
    if (tab.startsWith('game-')) {
      var gameNum = tab.split('-')[1];
      var game = games.findGame(+gameNum);
      if(game && game.role === Role.OBSERVING)
        var xcmd = 'xwhisper';
      else
        var xcmd = 'xkibitz';

      text = `${xcmd} ${gameNum} ${val}`;
    }
    else
      text = `t ${tab} ${val}`;
  }
  else
    text = val;

  // Check if input is a chat command, and if so do processing on the message before sending
  var match = text.match(/^\s*(\S+)\s+(\S+)\s+(.+)$/);
  if(match && match.length === 4 &&
      ('tell'.startsWith(match[1]) ||
      (('xwhisper'.startsWith(match[1]) || 'xkibitz'.startsWith(match[1]) || 'xtell'.startsWith(match[1])) && match[1].length >= 2))) {
    var chatCmd = match[1];
    var recipient = match[2];
    var message = match[3];
  }
  else {
    match = text.match(/^\s*([.,])\s*(.+)$/);
    if(!match)
      match = text.match(/^\s*(\S+)\s+(.+)$/);
    if(match && match.length === 3 &&
        ('kibitz'.startsWith(match[1]) || '.,'.includes(match[1]) ||
        (('whisper'.startsWith(match[1]) || 'say'.startsWith(match[1]) || 'ptell'.startsWith(match[1])) && match[1].length >= 2))) {
      var chatCmd = match[1];
      var message = match[2];
    }
  }

  if(chatCmd) {
    var maxLength = (session.isRegistered() ? 400 : 200);
    if(message.length > maxLength)
      message = message.slice(0, maxLength);

    message = Utils.unicodeToHTMLEncoding(message);
    var messages = Utils.splitText(message, maxLength); // if message is now bigger than maxLength chars due to html encoding split it

    for(let msg of messages) {
      if(('xtell'.startsWith(chatCmd) || 'tell'.startsWith(chatCmd)) && !/^\d+$/.test(recipient)) {
        chat.newMessage(recipient, {
          type: MessageType.PrivateTell,
          user: session.getUser(),
          message: msg,
        });
      }
      session.send(`${chatCmd} ${recipient ? `${recipient} ` : ''}${msg}`);
    }
  }
  else
    session.send(Utils.unicodeToHTMLEncoding(text));

  $('#input-text').val('');
  updateInputText();
});

$('#input-text').on('input', function() {
  updateInputText();
});

$('#input-text').on('keydown', function(event) {
  if(event.key === 'Enter') {
    event.preventDefault();
    $('#input-form').trigger('submit');
  }
});

$(document).on('shown.bs.tab', '#tabs button[data-bs-toggle="tab"]', (e) => {
  updateInputText();
});

function updateInputText() {
  var element = $('#input-text')[0] as HTMLTextAreaElement;
  var start = element.selectionStart;
  var end = element.selectionEnd;

  var val = element.value as string;
  val = val.replace(/[^\S ]/g, ' '); // replace all whitespace chars with spaces

  // Stop the user being able to type more than max length characters
  const tab = chat.currentTab();
  if(val.charAt(0) === '@')
    var maxLength = 1024;
  else if(tab === 'console')
    var maxLength = 1023;
  else if(!session.isRegistered()) // Guests are limited to half the tell length
    var maxLength = 200;
  else
    var maxLength = 400;

  if(val.length > maxLength)
    val = val.substring(0, maxLength);

  if(val !== element.value as string) {
    element.value = val;
    element.setSelectionRange(start, end);
  }

  adjustInputTextHeight(); // Resize text area
}

function adjustInputTextHeight() {
  var inputElem = $('#input-text');
  var oldLines = +inputElem.attr('rows');
  inputElem.attr('rows', 1);
  inputElem.css('overflow', 'hidden');

  var lineHeight = parseFloat(inputElem.css('line-height'));
  var numLines = Math.floor(inputElem[0].scrollHeight / lineHeight);
  var maxLines = 0.33 * $('#chat-panel').height() / lineHeight;
  if(numLines > maxLines)
    numLines = maxLines;

  inputElem.attr('rows', numLines);
  inputElem.css('overflow', '');

  var heightDiff = (numLines - 1) * lineHeight;
  $('#right-panel-footer').height($('#left-panel-footer').height() + heightDiff);

  if(numLines !== oldLines && chat)
    chat.fixScrollPosition();
}

