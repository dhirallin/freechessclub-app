// Copyright 2024 Free Chess Club.
// Use of this source code is governed by a GPL-style
// license that can be found in the LICENSE file.

import Chess from 'chess.js';

/** FEN and chess helper functions **/

export function parseMove(fen: string, move: any, startFen: string, category: string, holdings?: any) {
  // Parse variant move
  var standardCategories = ['blitz', 'lightning', 'untimed', 'standard', 'nonstandard'];
  if(!standardCategories.includes(category))
    return parseVariantMove(fen, move, startFen, category);

  // Parse standard move
  var chess = new Chess(fen);
  var outMove = chess.move(move);
  var outFen = chess.fen();

  if(!outMove || !outFen)
    return null;

  return { fen: outFen, move: outMove };
}

function parseVariantMove(fen: string, move: any, startFen: string, category: string, holdings?: any) {
  var supportedCategories = ['crazyhouse', 'bughouse', 'losers', 'wild/fr', 'wild/0', 'wild/1', 'wild/2', 'wild/3', 'wild/4', 'wild/5', 'wild/8', 'wild/8a'];
  if(!supportedCategories.includes(category))
    return null;

  var category = category;
  var chess = new Chess(fen);
  var san = '';

  // Convert algebraic coordinates to SAN for non-standard moves
  if (typeof move !== 'string') {
    if(move.from)
      var fromPiece = chess.get(move.from);
    else
      san = `${move.piece.toUpperCase()}@${move.to}`; // Crazyhouse/bughouse piece placement
    var toPiece = chess.get(move.to);

    if(fromPiece && fromPiece.type === 'k') {
      if((toPiece && toPiece.type === 'r' && toPiece.color === chess.turn())) { // Fischer random rook-castling
        if(move.to.charCodeAt(0) - move.from.charCodeAt(0) > 0)
          san = 'O-O';
        else
          san = 'O-O-O';
      }
      else if(Math.abs(move.to.charCodeAt(0) - move.from.charCodeAt(0)) > 1) { // Normal castling (king moved 2 or more squares)
        if(move.to.charCodeAt(0) - move.from.charCodeAt(0) > 0) { // King moved towards the h-file
          san = (category === 'wild/fr' || move.from[0] === 'e' ? 'O-O' : 'O-O-O');
        }
        else // King moved towards the a-file
          san = (category === 'wild/fr' || move.from[0] === 'e' ? 'O-O-O' : 'O-O');
      }
    }
    if(san)
      move = san;
  }
  else
    san = move;

  // Pre-processing of FEN before calling chess.move()
  var beforePre = splitFEN(fen); // Stores FEN components from before pre-processing of FEN starts
  var afterPre = Object.assign({}, beforePre); // Stores FEN components for after pre-procesisng is finished

  if(category.startsWith('wild')) {
    // Remove opponent's castling rights since it confuses chess.js
    if(beforePre.color === 'w') {
      var opponentRights = beforePre.castlingRights.replace(/[KQ-]/g,'');
      var castlingRights = beforePre.castlingRights.replace(/[kq]/g,'');
    }
    else {
      var opponentRights = beforePre.castlingRights.replace(/[kq-]/g,'');
      var castlingRights = beforePre.castlingRights.replace(/[KQ]/g,'');
    }
    if(castlingRights === '')
      castlingRights = '-';

    afterPre.castlingRights = castlingRights;
    fen = joinFEN(afterPre);
    chess.load(fen);
  }

  /*** Try to make standard move ***/
  var outMove = chess.move(move);
  var outFen = chess.fen();

  /*** Manually update FEN for non-standard moves ***/
  if(!outMove
      || (category.startsWith('wild') && san.toUpperCase().startsWith('O-O'))) {
    san = san.replace(/[+#]/, ''); // remove check and checkmate, we'll add it back at the end
    chess = new Chess(fen);
    outMove = {color: color, san: san};

    var board = afterPre.board;
    var color = afterPre.color;
    var castlingRights = afterPre.castlingRights;
    var enPassant = afterPre.enPassant;
    var plyClock = afterPre.plyClock;
    var moveNo = afterPre.moveNo;

    var boardAfter = board;
    var colorAfter = (color === 'w' ? 'b' : 'w');
    var castlingRightsAfter = castlingRights;
    var enPassantAfter = '-';
    var plyClockAfter = +plyClock + 1;
    var moveNoAfter = (colorAfter === 'w' ? +moveNo + 1 : moveNo);

    if(san.includes('@')) {
      // Parse crazyhouse or bughouse piece placement
      outMove.piece = san.charAt(0).toLowerCase();
      outMove.to = san.substring(2);

      // Can't place a pawn on the 1st or 8th rank
      var rank = outMove.to.charAt(1);

      if(outMove.piece === 'p' && (rank === '1' || rank === '8'))
        return null;

      chess.put({type: outMove.piece, color: color}, outMove.to);

      // Piece placement didn't block check/checkmate
      if(chess.in_check() || chess.in_checkmate())
        return null;

      outMove.flags = 'z';
      plyClockAfter = 0;
    }
    else if(san.toUpperCase() === 'O-O' || san.toUpperCase() === 'O-O-O') {
      // Parse irregular castling moves for fischer random and wild variants
      var rank = (color === 'w' ? '1' : '8');
      var cPieces = getCastlingPieces(startFen, color, category);
      var kingFrom = cPieces.king;
      var leftRook = cPieces.leftRook;
      var rightRook = cPieces.rightRook;

      if(san.toUpperCase() === 'O-O') {
        if(category === 'wild/fr') {
          // fischer random
          var kingTo = `g${rank}`;
          var rookFrom = rightRook;
          var rookTo = `f${rank}`;
        }
        else {
          // wild/0, wild/1 etc
          if(kingFrom[0] === 'e') {
            var kingTo = `g${rank}`;
            var rookFrom = rightRook;
            var rookTo = `f${rank}`;
          }
          else {
            var kingTo = `b${rank}`;
            var rookFrom = leftRook;
            var rookTo = `c${rank}`;
          }
        }
      }
      else if(san.toUpperCase() === 'O-O-O') {
        if(category === 'wild/fr') {
          var kingTo = `c${rank}`;
          var rookFrom = leftRook;
          var rookTo = `d${rank}`;
        }
        else {
          // wild/0, wild/1
          if(kingFrom[0] === 'e') {
            var kingTo = `c${rank}`;
            var rookFrom = leftRook;
            var rookTo = `d${rank}`;
          }
          else {
            var kingTo = `f${rank}`;
            var rookFrom = rightRook;
            var rookTo = `e${rank}`;
          }
        }
      }

      if(rookFrom === leftRook) {
        // Do we have castling rights?
        if(!castlingRights.includes(color === 'w' ? 'Q' : 'q'))
          return null;

        outMove.flags = 'q';
      }
      else {
        if(!castlingRights.includes(color === 'w' ? 'K' : 'k'))
          return null;

        outMove.flags = 'k';
      }

      // Check castling is legal
      // Can king pass through all squares between start and end squares?
      if(kingFrom.charCodeAt(0) < kingTo.charCodeAt(0)) {
        var startCode = kingFrom.charCodeAt(0);
        var endCode = kingTo.charCodeAt(0);
      }
      else {
        var startCode = kingTo.charCodeAt(0);
        var endCode = kingFrom.charCodeAt(0);
      }
      for(let code = startCode; code <= endCode; code++) {
        var square = `${String.fromCharCode(code)}${kingFrom[1]}`;
        // square blocked?
        if(square !== kingFrom && square !== rookFrom && chess.get(square))
          return null;
        // square under attack?
        if(isAttacked(fen, square, color))
          return null;
      }
      // Can rook pass through all squares between start and end squares?
      if(rookFrom.charCodeAt(0) < rookTo.charCodeAt(0)) {
        var startCode = rookFrom.charCodeAt(0);
        var endCode = rookTo.charCodeAt(0);
      }
      else {
        var startCode = rookTo.charCodeAt(0);
        var endCode = rookFrom.charCodeAt(0);
      }
      for(let code = startCode; code <= endCode; code++) {
        var square = `${String.fromCharCode(code)}${rookFrom[1]}`;
        // square blocked?
        if(square !== rookFrom && square !== kingFrom && chess.get(square))
          return null;
      }

      chess.remove(kingFrom);
      chess.remove(rookFrom);
      chess.put({type: 'k', color: color}, kingTo);
      chess.put({type: 'r', color: color}, rookTo);

      var castlingRightsAfter = castlingRights;
      if(rookFrom === leftRook)
        castlingRightsAfter = castlingRightsAfter.replace((color === 'w' ? 'Q' : 'q'), '');
      else
        castlingRightsAfter = castlingRightsAfter.replace((color === 'w' ? 'K' : 'k'), '');

      // On FICS there is a weird bug (feature?) where as long as the king hasn't moved after castling,
      // you can castle again!
      if(kingFrom !== kingTo) {
        if(rookFrom === leftRook)
          castlingRightsAfter = castlingRightsAfter.replace((color === 'w' ? 'K' : 'k'), '');
        else
          castlingRightsAfter = castlingRightsAfter.replace((color === 'w' ? 'Q' : 'q'), '');
      }

      if(castlingRightsAfter === '')
        castlingRightsAfter = '-';

      outMove.piece = 'k';
      outMove.from = kingFrom;

      if(category === 'wild/fr')
        outMove.to = rookFrom; // Fischer random specifies castling to/from coorindates using 'rook castling'
      else
        outMove.to = kingTo;
    }

    var boardAfter = chess.fen().split(/\s+/)[0];
    outFen = `${boardAfter} ${colorAfter} ${castlingRightsAfter} ${enPassantAfter} ${plyClockAfter} ${moveNoAfter}`;

    chess.load(outFen);
    if(chess.in_checkmate())
      outMove.san += '#';
    else if(chess.in_check())
      outMove.san += '+';
  }

  // Post-processing on FEN after calling chess.move()
  var beforePost = splitFEN(outFen); // Stores FEN components before post-processing starts
  var afterPost = Object.assign({}, beforePost); // Stores FEN components after post-processing is completed

  if(category === 'crazyhouse' || category === 'bughouse') {
    afterPost.plyClock = '0'; // FICS doesn't use the 'irreversable moves count' for crazyhouse/bughouse, so set it to 0

    // Check if it's really mate, i.e. player can't block with a held piece
    // (Yes this is a lot of code for something so simple)
    if(chess.in_checkmate()) {
      // Get square of king being checkmated
      for(const s of chess.SQUARES) {
        var piece = chess.get(s);
        if(piece && piece.type === 'k' && piece.color === chess.turn()) {
          var kingSquare = s;
          break;
        }
      }
      // place a pawn on every adjacent square to the king and check if it blocks the checkmate
      // If so the checkmate can potentially be blocked by a held piece
      var adjacent = getAdjacentSquares(kingSquare);
      var blockingSquare = null;
      for(let adj of adjacent) {
        if(!chess.get(adj)) {
          chess.put({type: 'p', color: chess.turn()}, adj);
          if(!chess.in_checkmate()) {
            blockingSquare = adj;
            break;
          }
          chess.remove(adj);
        }
      };
      if(blockingSquare) {
        if(category === 'crazyhouse') {
          // check if we have a held piece capable of occupying the blocking square
          var canBlock = false;
          for(let k in holdings) {
            if(holdings[k] === 0)
              continue;

            if((chess.turn() === 'w' && k.toLowerCase() !== k) ||
                (chess.turn() === 'b' && k.toUpperCase() !== k))
              continue;

            // held pawns can't be placed on the 1st or 8th rank
            var rank = blockingSquare.charAt(1);
            if(k.toLowerCase() !== 'p' || (rank !== '1' && rank !== '8'))
              canBlock = true;
          }
        }
        // If playing a bughouse game, and the checkmate can be blocked in the future, then it's not checkmate
        if(category === 'bughouse' || canBlock)
          outMove.san = outMove.san.replace('#', '+');
      }
    }
  }
  if(category.startsWith('wild')) {
    if(!san.toUpperCase().startsWith('O-O')) {
      // Restore castling rights which chess.js erroneously removes
      afterPost.castlingRights = afterPre.castlingRights;
      outFen = joinFEN(afterPost);
      // Adjust castling rights after rook or king move (not castling)
      outFen = adjustCastlingRights(outFen, startFen, category);
      afterPost.castlingRights = splitFEN(outFen).castlingRights;
    }
    if(opponentRights) {
      // Restore opponent's castling rights (which were removed at the start so as not to confuse chess.js)
      var castlingRights = afterPost.castlingRights;
      if(castlingRights === '-')
        castlingRights = '';
      if(afterPost.color === 'w')
        afterPost.castlingRights = `${opponentRights}${castlingRights}`;
      else
        afterPost.castlingRights = `${castlingRights}${opponentRights}`;
    }
  }
  outFen = joinFEN(afterPost);

  // Move was not made, something went wrong
  if(afterPost.board === beforePre.board)
    return null;

  if(!outMove || !outFen)
    return null;

  return {fen: outFen, move: outMove};
}

export function toDests(fen: string, startFen: string, category: string, holdings?: any): Map<string, string[]> {
  var standardCategories = ['blitz', 'lightning', 'untimed', 'standard', 'nonstandard', 'crazyhouse', 'bughouse'];
  if(!standardCategories.includes(category))
    return variantToDests(fen, startFen, category);

  var dests = new Map();
  var chess = new Chess(fen);
  chess.SQUARES.forEach(s => {
    var ms = chess.moves({square: s, verbose: true});
    if(ms.length)
      dests.set(s, ms.map(m => m.to));
  });

  return dests;
}

function variantToDests(fen: string, startFen: string, category: string, holdings?: any): Map<string, string[]> {
  var supportedCategories = ['crazyhouse', 'bughouse', 'losers', 'wild/fr', 'wild/0', 'wild/1', 'wild/2', 'wild/3', 'wild/4', 'wild/5', 'wild/8', 'wild/8a'];
  if(!supportedCategories.includes(category))
    return null;

  var chess = new Chess(fen);

  // In 'losers' variant, if a capture is possible then include only captures in dests
  if(category === 'losers') {
    var dests = new Map();
    chess.SQUARES.forEach(s => {
      var ms = chess.moves({square: s, verbose: true}).filter((m) => {
        return /[ec]/.test(m.flags);
      });
      if(ms.length)
        dests.set(s, ms.map(m => m.to));
    });
  }

  if(!dests || !dests.size) {
    var dests = new Map();
    chess.SQUARES.forEach(s => {
      var ms = chess.moves({square: s, verbose: true});
      if(ms.length)
        dests.set(s, ms.map(m => m.to));
    });
  }

  // Add irregular castling moves for wild variants
  if(category.startsWith('wild')) {
    var cPieces = getCastlingPieces(startFen, chess.turn(), category);
    var king = cPieces.king;
    var leftRook = cPieces.leftRook;
    var rightRook = cPieces.rightRook;

    // Remove any castling moves already in dests
    var kingDests = dests.get(king);
    if(kingDests) {
      kingDests.filter((dest) => {
        return Math.abs(dest.charCodeAt(0) - king.charCodeAt(0)) > 1;
      }).forEach((dest) => {
        kingDests.splice(kingDests.indexOf(dest), 1);
      });
      if(kingDests.length === 0)
        dests.delete(king);
    }

    var parsedMove = parseMove(chess.fen(), 'O-O', startFen, category, holdings);
    if(parsedMove) {
      var from = parsedMove.move.from;
      if(category === 'wild/fr')
        var to = rightRook;
      else
        var to = parsedMove.move.to;
      var kingDests = dests.get(from);
      if(kingDests)
        kingDests.push(to);
      else dests.set(from, [to]);
    }
    var parsedMove = parseMove(chess.fen(), 'O-O-O', startFen, category, holdings);
    if(parsedMove) {
      var from = parsedMove.move.from;
      if(category === 'wild/fr')
        var to = leftRook;
      else
        var to = parsedMove.move.to;
      var kingDests = dests.get(from);
      if(kingDests)
        kingDests.push(to);
      else dests.set(from, [to]);
    }
  }

  return dests;
}

/**
 * Split a FEN into its component parts 
 */
export function splitFEN(fen: string) {
  var words = fen.split(/\s+/);
  return {
    board: words[0],
    color: words[1],
    castlingRights: words[2],
    enPassant: words[3],
    plyClock: words[4],
    moveNo: words[5]
  };
}

/**
 * Create a FEN from an object containing its component parts 
 */
export function joinFEN(obj: any): string {
  return Object.keys(obj).map(key => obj[key]).join(' ');
}

export function getPlyFromFEN(fen: string): number {
  const turn_color = fen.split(/\s+/)[1];
  const move_no = +fen.split(/\s+/).pop();
  const ply = move_no * 2 - (turn_color === 'w' ? 1 : 0);

  return ply;
}

export function getMoveNoFromFEN(fen: string): number {
  return +fen.split(/\s+/).pop();
}

export function getTurnColorFromFEN(fen: string): string {
  return fen.split(/\s+/)[1];
}

/**
 * Checks if a fen is in a valid format and represents a valid position.
 * @returns null if fen is valid, otherwise an error string
 */
export function validateFEN(fen: string, category?: string): string {
  var chess = new Chess(fen);
  if(!chess)
    return 'Invalid FEN format.';

  var fenWords = splitFEN(fen);
  var color = fenWords.color;
  var board = fenWords.board;
  var castlingRights = fenWords.castlingRights;

  var oppositeColor = color === 'w' ? 'b' : 'w';
  var tempFen = fen.replace(` ${color} `, ` ${oppositeColor} `);
  chess.load(tempFen);
  if(chess.in_check()) {
    if(color === 'w')
      return 'White\'s turn but black is in check.';
    else
      return 'Black\'s turn but white is in check.';
  }
  chess.load(fen);

  if(!board.includes('K') || !board.includes('k'))
    return 'Missing king.';

  if(/(K.*K|k.*k)/.test(board))
    return 'Too many kings.';

  var match = board.match(/(\w+)(?:\/\w+){6}\/(\w+)/);
  var rank8 = match[1];
  var rank1 = match[2];
  if(/[pP]/.test(rank1) || /[pP]/.test(rank8))
    return 'Pawn on 1st or 8th rank.';

  // Check castling rights
  if(castlingRights.includes('K') || castlingRights.includes('Q')) {
    var castlingPieces = getCastlingPieces(fen, 'w', category);
    if(!castlingPieces.king
        || (!castlingPieces.leftRook && castlingRights.includes('Q'))
        || (!castlingPieces.rightRook && castlingRights.includes('K')))
      return 'White\'s king or rooks aren\'t in valid locations for castling.';
  }
  if(castlingRights.includes('k') || castlingRights.includes('q')) {
    var castlingPieces = getCastlingPieces(fen, 'b', category);
    if(!castlingPieces.king
        || (!castlingPieces.leftRook && castlingRights.includes('q'))
        || (!castlingPieces.rightRook && castlingRights.includes('k')))
      return 'Black\'s king or rooks aren\'t in valid locations for castling.';
  }

  return null;
}

/**
 * Gets the positions of the 'castle-able' kings and rooks from the starting position for the given color.
 * @param fen starting position
 * @param color 'w' or 'b'
 * @returns An object in the form { king: '<square>', leftRook: '<square>', rightRook: '<square>' }
 */
export function getCastlingPieces(fen: string, color: string, category?: string): { [key: string]: string } {
  var chess = new Chess(fen);

  var oppositeColor = (color === 'w' ? 'b' : 'w');
  var rank = (color === 'w' ? '1' : '8');
  var files = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
  var leftRook = '', rightRook = '', king = '';
  for(const file of files) {
    let square = `${file}${rank}`;
    let p = chess.get(square);
    if(p && p.type === 'r' && p.color === color) { // Get starting location of rooks
      if(category === 'wild/fr') {
        // Note in weird cases where the starting position has more than 2 rooks on the back row
        // We try to guess which are the real castling rooks. If a rook has an opposite coloured rook in
        // the equivalent position on the other side of the board, then it's more likely to be a genuine
        // castling rook. Otherwise we use the rook which is closest to the king on either side.
        var hasOppositeRook = false, oppositeLeftRookFound = false, oppositeRightRookFound = false;
        let opSquare = `${file}${rank === '1' ? '8' : '1'}`;
        let opP = chess.get(opSquare);
        if(opP && opP.type === 'r' && p.color === oppositeColor)
          hasOppositeRook = true;

        if(!king && (hasOppositeRook || !oppositeLeftRookFound)) {
          var leftRook = square;
          if(hasOppositeRook)
            oppositeLeftRookFound = true;
        }
        else if(!rightRook || (hasOppositeRook && !oppositeRightRookFound)) {
          var rightRook = square;
          if(hasOppositeRook)
            oppositeRightRookFound = true;
        }
      }
      else {
        if(file === 'a')
          leftRook = square;
        else if(file === 'h')
          rightRook = square;
      }
    }
    else if(p && p.type === 'k' && p.color === color) { // Get starting location of king
      if(category === 'wild/fr'
          || (category === 'wild/0' && ((color === 'w' && file === 'e') || (color === 'b' && file === 'd')))
          || (category === 'wild/1' && (file === 'd' || file === 'e'))
          || file === 'e')
        king = square;
    }
  }

  return {king, leftRook, rightRook};
}

/**
 * Determines if castling rights need to be removed for a given fen, based on
 * the initial positions of the kings and rooks from the starting position. I.e. If the king or
 * rooks are no longer in their starting positions.
 * @param fen the fen being inspected
 * @param startFen the starting position of the game. If not specified, gets the starting position
 * from the Game's move list.
 * @returns the fen with some castling rights possibly removed
 */
export function adjustCastlingRights(fen: string, startFen: string, category?: string): string {
  var fenWords = splitFEN(fen);
  var castlingRights = fenWords.castlingRights;
  var chess = new Chess(fen);
  if(!chess)
    return fen;

  var cp = getCastlingPieces(startFen, 'w', category); // Gets the initial locations of the 'castle-able' king and rooks
  if(cp.king) {
    var piece = chess.get(cp.king);
    if(!piece || piece.type !== 'k' || piece.color !== 'w')
      castlingRights = castlingRights.replace(/[KQ]/g, '');
  }
  if(cp.leftRook) {
    var piece = chess.get(cp.leftRook);
    if(!piece || piece.type !== 'r' || piece.color !== 'w')
      castlingRights = castlingRights.replace('Q', '');
  }
  if(cp.rightRook) {
    var piece = chess.get(cp.rightRook);
    if(!piece || piece.type !== 'r' || piece.color !== 'w')
      castlingRights = castlingRights.replace('K', '');
  }

  var cp = getCastlingPieces(startFen, 'b', category);
  if(cp.king) {
    var piece = chess.get(cp.king);
    if(!piece || piece.type !== 'k' || piece.color !== 'b')
      castlingRights = castlingRights.replace(/[kq]/g, '');
  }
  if(cp.leftRook) {
    var piece = chess.get(cp.leftRook);
    if(!piece || piece.type !== 'r' || piece.color !== 'b')
      castlingRights = castlingRights.replace('q', '');
  }
  if(cp.rightRook) {
    var piece = chess.get(cp.rightRook);
    if(!piece || piece.type !== 'r' || piece.color !== 'b')
      castlingRights = castlingRights.replace('k', '');
  }

  if(!castlingRights)
    castlingRights = '-';

  fenWords.castlingRights = castlingRights;
  return joinFEN(fenWords);
}

export function swapColor(color: string): string {
  return (color === 'w') ? 'b' : 'w';
}

export function inCheck(san: string) {
  return (san.slice(-1) === '+');
}

// Check if square is under attack. We can remove this after upgrading to latest version of chess.js,
// since it has its own version of the function
export function isAttacked(fen: string, square: string, color: string) : boolean {
  var oppositeColor = color === 'w' ? 'b' : 'w';

  // Switch to the right turn
  if(getTurnColorFromFEN(fen) !== color)
    fen = fen.replace(` ${oppositeColor} `, ` ${color} `);

  var chess = new Chess(fen);

  // Find king and replace it with a placeholder pawn
  for(const s in Chess.SQUARES) {
    var piece = chess.get(s);
    if(piece && piece.type === 'k' && piece.color === color) {
      chess.remove(s);
      chess.put({type: 'p', color: color}, s);
      break;
    }
  }

  // Place king on square we want to test and see if it's in check
  chess.remove(square);
  chess.put({type: 'k', color: color}, square);
  return chess.in_check() ? true : false;
}

// Helper function which returns an array of square coordinates which are adjacent (including diagonally) to the given square
export function getAdjacentSquares(square: string) : string[] {
  var adjacent = [];
  var file = square[0];
  var rank = square[1];
  if(rank !== '1')
    adjacent.push(`${file}${+rank - 1}`);
  if(rank !== '8')
    adjacent.push(`${file}${+rank + 1}`);
  if(file !== 'a') {
    var prevFile = String.fromCharCode(file.charCodeAt(0) - 1);
    adjacent.push(`${prevFile}${rank}`);
    if(rank !== '1')
      adjacent.push(`${prevFile}${+rank - 1}`);
    if(rank !== '8')
      adjacent.push(`${prevFile}${+rank + 1}`);
  }
  if(file !== 'h') {
    var nextFile = String.fromCharCode(file.charCodeAt(0) + 1);
    adjacent.push(`${nextFile}${rank}`);
    if(rank !== '1')
      adjacent.push(`${nextFile}${+rank - 1}`);
    if(rank !== '8')
      adjacent.push(`${nextFile}${+rank + 1}`);
  }
  return adjacent;
}

export function generateChess960FEN(idn?: number): string {
  // Generate random Chess960 starting position using Scharnagl's method.

  const kingsTable = {
    0: 'QNNRKR',   192: 'QNRKNR',   384: 'QRNNKR',   576: 'QRNKRN',   768: 'QRKNRN',
    16: 'NQNRKR',   208: 'NQRKNR',   400: 'RQNNKR',   592: 'RQNKRN',   784: 'RQKNRN',
    32: 'NNQRKR',   224: 'NRQKNR',   416: 'RNQNKR',   608: 'RNQKRN',   800: 'RKQNRN',
    48: 'NNRQKR',   240: 'NRKQNR',   432: 'RNNQKR',   624: 'RNKQRN',   816: 'RKNQRN',
    64: 'NNRKQR',   256: 'NRKNQR',   448: 'RNNKQR',   640: 'RNKRQN',   832: 'RKNRQN',
    80: 'NNRKRQ',   272: 'NRKNRQ',   464: 'RNNKRQ',   656: 'RNKRNQ',   848: 'RKNRNQ',
    96: 'QNRNKR',   288: 'QNRKRN',   480: 'QRNKNR',   672: 'QRKNNR',   864: 'QRKRNN',
    112: 'NQRNKR',  304: 'NQRKRN',  496: 'RQNKNR',   688: 'RQKNNR',   880: 'RQKRNN',
    128: 'NRQNKR',  320: 'NRQKRN',  512: 'RNQKNR',   704: 'RKQNNR',   896: 'RKQRNN',
    144: 'NRNQKR',  336: 'NRKQRN',  528: 'RNKQNR',   720: 'RKNQNR',   912: 'RKRQNN',
    160: 'NRNKQR',  352: 'NRKRQN',  544: 'RNKNQR',   736: 'RKNNQR',   928: 'RKRNQN',
    176: 'NRNKRQ',  368: 'NRKRNQ',  560: 'RNKNRQ',   752: 'RKNNRQ',   944: 'RKRNNQ'
  };

  const bishopsTable = [
    ['B', 'B', '-', '-', '-', '-', '-', '-'],
    ['B', '-', '-', 'B', '-', '-', '-', '-'],
    ['B', '-', '-', '-', '-', 'B', '-', '-'],
    ['B', '-', '-', '-', '-', '-', '-', 'B'],
    ['-', 'B', 'B', '-', '-', '-', '-', '-'],
    ['-', '-', 'B', 'B', '-', '-', '-', '-'],
    ['-', '-', 'B', '-', '-', 'B', '-', '-'],
    ['-', '-', 'B', '-', '-', '-', '-', 'B'],
    ['-', 'B', '-', '-', 'B', '-', '-', '-'],
    ['-', '-', '-', 'B', 'B', '-', '-', '-'],
    ['-', '-', '-', '-', 'B', 'B', '-', '-'],
    ['-', '-', '-', '-', 'B', '-', '-', 'B'],
    ['-', 'B', '-', '-', '-', '-', 'B', '-'],
    ['-', '-', '-', 'B', '-', '-', 'B', '-'],
    ['-', '-', '-', '-', '-', 'B', 'B', '-'],
    ['-', '-', '-', '-', '-', '-', 'B', 'B']
  ];

  if(!(idn >= 0 && idn <= 959))
    var idn = Math.floor(Math.random() * 960); // Get random Chess960 starting position identification number
  var kIndex = idn - idn % 16; // Index into King's Table
  var bIndex = idn - kIndex; // Index into Bishop's Table
  var kEntry = kingsTable[kIndex];

  // Fill in empty spots in the row from Bishop's Table with pieces from the row in King's Table
  var backRow = [...bishopsTable[bIndex]]; // Copy row from array
  var p = 0;
  for(let sq = 0; sq < 8; sq++) {
    if(backRow[sq] === '-') {
      backRow[sq] = kEntry[p];
      p++;
    }
  }

  var whiteBackRow = backRow.join('');
  var blackBackRow = whiteBackRow.toLowerCase();
  var fen = `${blackBackRow}/pppppppp/8/8/8/8/PPPPPPPP/${whiteBackRow} w KQkq - 0 1`;

  return fen;
}

/**
 * Returns move as a string in coordinate form (e.g a1-d4)
 */
 export function moveToCoordinateString(move: any): string {  
  var moveStr = '';
  if(move.san && move.san.startsWith('O-O')) // support for variants
    moveStr = move.san;
  else if(!move.from)
    moveStr = `${move.piece}@${move.to}`; // add piece in crazyhouse or bsetup mode
  else if(!move.to)
    moveStr = `x${move.from}`; // remove piece in bsetup mode
  else
    moveStr = `${move.from}-${move.to}${move.promotion ? '=' + move.promotion : ''}`;

  return moveStr;
}
