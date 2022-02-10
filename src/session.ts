// Copyright 2019 Free Chess Club.
// Use of this source code is governed by a GPL-style
// license that can be found in the LICENSE file.

import Parser from './parser';

export const enum MessageType {
  Control = 0,
  ChannelTell,
  PrivateTell,
  GameMove,
  GameStart,
  GameEnd,
  Unknown,
}

export function GetMessageType(msg: any): MessageType {
  if (msg.fen !== undefined) {
    return MessageType.GameMove;
  } else if (msg.control !== undefined) {
    return MessageType.Control;
  } else if (msg.player_one !== undefined) {
    return MessageType.GameStart;
  } else if (msg.winner !== undefined) {
    return MessageType.GameEnd;
  } else if (msg.channel !== undefined) {
    return MessageType.ChannelTell;
  } else if (msg.user !== undefined && msg.message !== undefined) {
    return MessageType.PrivateTell;
  } else {
    return MessageType.Unknown;
  }
}

export class Session {
  private connected: boolean;
  private proxy: boolean;
  private user: string;
  private websocket: WebSocket;
  private onRecv: (msg: any) => void;

  constructor(onRecv: (msg: any) => void, proxy: boolean, user?: string, pass?: string) {
    this.connected = false;
    this.proxy = proxy;
    this.user = '';
    this.onRecv = onRecv;
    this.connect(proxy, user, pass);
  }

  public getUser(): string {
    return this.user;
  }

  public setUser(user: string): void {
    this.connected = true;
    this.user = user;
    $('#chat-status').html('<span class="fa fa-circle text-success" aria-hidden="false"></span> <span class="h6 align-middle"> '
      + user + '</span>');
    $('#chat-status').popover({
      animation: true,
      content: 'Connected as ' + user + '. Click here to connect as a different user!',
      placement: 'top',
    });
    $('#chat-status').popover('show');
    setInterval(() => $('#chat-status').popover('dispose'), 3600);
  }

  public isConnected(): boolean {
    return this.connected;
  }

  public connect(proxy: boolean, user?: string, pass?: string) {
    $('#chat-status').html('<span class="spinner-grow spinner-grow-sm text-warning" role="status" aria-hidden="true"></span> Connecting...');
    const login = (user !== undefined && pass !== undefined);
    let loginOptions = '';
    let text = '';
    if (login) {
      loginOptions += '?login=1';
      text = '[' + user;
      if (pass !== undefined && pass.length > 0) {
        text += ',' + btoa(pass);
      }
      text += ']';
    }

    let host = location.host;
    if (host === '') {
      host = 'www.freechess.club';
    }

    let protocol = 'ws://';
    if (location.protocol === 'https:' || location.protocol === 'file:') {
      protocol = 'wss://';
    }

    const uri = proxy ? (protocol + host + '/ws' + loginOptions) : 'ws://www.freechess.org:5001';
    this.websocket = new WebSocket(uri);
    const parser = new Parser(this, user, pass);
    this.websocket.onmessage = async (message: any) => {
      const data = proxy ? JSON.parse(message.data) : await parser.parse(message.data);
      if (Array.isArray(data)) {
        data.map((m) => this.onRecv(m));
      } else {
        this.onRecv(data);
      }
    };
    this.websocket.onclose = this.reset;
    if (login) {
      this.websocket.onopen = () => {
        $('#chat-status').html('<span class="spinner-grow spinner-grow-sm text-warning" role="status" aria-hidden="true"></span> Connecting...');
        this.websocket.send(text);
      };
    }
  }

  public disconnect() {
    $('#chat-status').html('<span class="spinner-grow spinner-grow-sm text-danger" role="status" aria-hidden="true"></span> Disconnecting...');
    if (this.isConnected()) {
      this.websocket.close();
      this.connected = false;
      this.user = '';
    }
  }

  public reset(_e: any) {
    $('#chat-status').html('<span class="fa fa-circle text-danger" aria-hidden="false"></span> Offline');
  }

  public send(command: string) {
    if (!this.proxy) {
      command += '\n';
    }
    this.websocket.send(command);
  }
}

export default Session;
