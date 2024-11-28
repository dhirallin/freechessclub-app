// Copyright 2024 Free Chess Club.
// Use of this source code is governed by a GPL-style
// license that can be found in the LICENSE file.

import Chess from 'chess.js';

/** FEN and chess helper functions **/

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
