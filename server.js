const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ============ 数据存储 ============
const users = new Map(); // userId -> { username, avatar, password }
const rooms = new Map(); // roomId -> room object
const userSocketMap = new Map(); // userId -> socketId

// 默认头像列表
const defaultAvatars = [
  '🦁','🐯','🐻','🐼','🦊','🐰','🐸','🐵','🦄','🐲',
  '👑','🎩','🎭','🎯','🏆','⭐','🔥','💎','🌸','🍀'
];

// ============ AI机器人 ============
const aiNames = [
  '小明','阿花','大壮','翠花','铁柱','二丫','狗蛋','翠翠',
  '老王','小丽','阿强','秀英','建国','美兰','志强','春花',
  '大明','小红','阿宝','小燕','大伟','小芳','国强','秀兰',
  '阿杰','小美','大鹏','阿霞','小刚','丽华','文杰','玉兰'
];
const aiAvatars = [
  '🤖','👽','🎮','👾','🦾','🧠','🤡','👹',
  '💀','👻','🎃','🦹','🧙','🧛','🧞','🧜',
  '🧝','🧚','🎪','🎭','🎭','🎯','🎯','🏆'
];
let aiNameCounter = 0;

function generateAIName() {
  let name;
  do {
    name = aiNames[aiNameCounter % aiNames.length];
    if (aiNameCounter >= aiNames.length) {
      name += '_' + Math.floor(aiNameCounter / aiNames.length);
    }
    aiNameCounter++;
  } while (false);
  return name;
}

function generateAIAvatar() {
  return aiAvatars[Math.floor(Math.random() * aiAvatars.length)];
}

// ============ 扑克牌逻辑 ============
const SUITS = ['♠', '♥', '♣', '♦'];
const SUIT_ORDER = { '♠': 4, '♥': 3, '♣': 2, '♦': 1 };
const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const RANK_VALUES = { 'A': 1, '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, '10': 10, 'J': 10, 'Q': 10, 'K': 10 };

function createDeck() {
  const deck = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      deck.push({ suit, rank, value: RANK_VALUES[rank] });
    }
  }
  return deck;
}

function shuffleDeck(deck) {
  const d = [...deck];
  for (let i = d.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}

// 计算牛型
function calculateNiu(cards) {
  const values = cards.map(c => c.value);
  const total = values.reduce((a, b) => a + b, 0);

  // 五小牛: 所有牌点数<=5 且总和<=10
  if (values.every(v => v <= 5) && total <= 10) {
    return { type: '五小牛', level: 12, multiplier: 5 };
  }

  // 炸弹: 4张同点
  const rankCount = {};
  for (const c of cards) {
    rankCount[c.rank] = (rankCount[c.rank] || 0) + 1;
  }
  for (const r in rankCount) {
    if (rankCount[r] === 4) {
      return { type: '炸弹', level: 11, multiplier: 6 };
    }
  }

  // 牛牛计算: 找3张组合=10的倍数
  for (let i = 0; i < 5; i++) {
    for (let j = i + 1; j < 5; j++) {
      for (let k = j + 1; k < 5; k++) {
        if ((values[i] + values[j] + values[k]) % 10 === 0) {
          const rest = [0, 1, 2, 3, 4].filter(x => x !== i && x !== j && x !== k);
          const niuVal = (values[rest[0]] + values[rest[1]]) % 10;
          const niu = niuVal === 0 ? 10 : niuVal;
          if (niu === 10) {
            return { type: '牛牛', level: 10, multiplier: 4 };
          } else if (niu === 9) {
            return { type: '牛九', level: 9, multiplier: 3 };
          } else if (niu === 8) {
            return { type: '牛八', level: 8, multiplier: 2 };
          } else {
            return { type: '牛' + niu, level: niu, multiplier: 1 };
          }
        }
      }
    }
  }

  return { type: '无牛', level: 0, multiplier: 1 };
}

// 比较最大牌
function getMaxCard(cards) {
  return cards.reduce((max, c) => {
    const cIdx = RANKS.indexOf(c.rank);
    const mIdx = RANKS.indexOf(max.rank);
    if (cIdx > mIdx) return c;
    if (cIdx === mIdx) {
      return SUIT_ORDER[c.suit] > SUIT_ORDER[max.suit] ? c : max;
    }
    return max;
  });
}

// 比较两手牌
function compareHands(a, b) {
  // 先比牌型level
  if (a.niuResult.level !== b.niuResult.level) {
    return a.niuResult.level > b.niuResult.level ? 1 : -1;
  }
  // 牌型相同比最大牌
  const maxA = getMaxCard(a.cards);
  const maxB = getMaxCard(b.cards);
  const idxA = RANKS.indexOf(maxA.rank);
  const idxB = RANKS.indexOf(maxB.rank);
  if (idxA !== idxB) return idxA > idxB ? 1 : -1;
  return SUIT_ORDER[maxA.suit] > SUIT_ORDER[maxB.suit] ? 1 : -1;
}

// ============ 房间管理 ============
function getRoomList() {
  const list = [];
  for (const [id, room] of rooms) {
    list.push({
      roomId: id,
      roomName: room.roomName,
      hostName: room.hostName,
      playerCount: room.players.length,
      maxPlayers: room.maxPlayers,
      hasPassword: !!room.password,
      initialMoney: room.initialMoney,
      round: room.round,
      status: room.status
    });
  }
  return list;
}

// ============ Socket.IO 事件 ============
io.on('connection', (socket) => {
  console.log('用户连接:', socket.id);
  let currentUserId = null;
  let currentRoomId = null;

  // 注册
  socket.on('register', ({ username, password }, callback) => {
    if (!username || !password) {
      return callback({ success: false, msg: '用户名和密码不能为空' });
    }
    // 检查用户名是否已存在
    for (const [, u] of users) {
      if (u.username === username) {
        return callback({ success: false, msg: '用户名已存在' });
      }
    }
    const userId = uuidv4();
    const avatar = defaultAvatars[Math.floor(Math.random() * defaultAvatars.length)];
    users.set(userId, { userId, username, password, avatar });
    currentUserId = userId;
    userSocketMap.set(userId, socket.id);
    callback({ success: true, user: { userId, username, avatar } });
  });

  // 登录
  socket.on('login', ({ username, password }, callback) => {
    let found = null;
    for (const [, u] of users) {
      if (u.username === username && u.password === password) {
        found = u;
        break;
      }
    }
    if (!found) {
      return callback({ success: false, msg: '用户名或密码错误' });
    }
    currentUserId = found.userId;
    userSocketMap.set(found.userId, socket.id);
    callback({ success: true, user: { userId: found.userId, username: found.username, avatar: found.avatar } });
  });

  // 修改用户信息
  socket.on('updateProfile', ({ username, avatar }, callback) => {
    if (!currentUserId) return callback({ success: false, msg: '未登录' });
    const user = users.get(currentUserId);
    if (!user) return callback({ success: false, msg: '用户不存在' });
    if (username) user.username = username;
    if (avatar) user.avatar = avatar;
    callback({ success: true, user: { userId: user.userId, username: user.username, avatar: user.avatar } });
  });

  // 获取房间列表
  socket.on('getRoomList', (callback) => {
    callback(getRoomList());
  });

  // 创建房间
  socket.on('createRoom', ({ roomName, password, initialMoney, maxPlayers }, callback) => {
    if (!currentUserId) return callback({ success: false, msg: '请先登录' });
    const user = users.get(currentUserId);
    if (!user) return callback({ success: false, msg: '用户不存在' });

    const roomId = uuidv4().substring(0, 6).toUpperCase();
    const room = {
      roomId,
      roomName: roomName || (user.username + '的房间'),
      hostId: currentUserId,
      hostName: user.username,
      password: password || '',
      maxPlayers: maxPlayers || 10,
      initialMoney: initialMoney || 1000,
      round: 0,
      status: 'waiting', // waiting / playing
      players: [{
        userId: currentUserId,
        username: user.username,
        avatar: user.avatar,
        money: initialMoney || 1000,
        isHost: true,
        cards: [],
        niuResult: null,
        isReady: false,
        disconnected: false,
        isAI: false
      }],
      dealerIndex: 0, // 庄家索引
      bets: new Map()
    };
    rooms.set(roomId, room);
    currentRoomId = roomId;
    socket.join(roomId);
    callback({ success: true, roomId, room: getRoomInfo(room) });
  });

  // 添加AI机器人
  socket.on('addAI', ({ roomId, count }, callback) => {
    if (!currentUserId) return callback({ success: false, msg: '请先登录' });
    const room = rooms.get(roomId);
    if (!room) return callback({ success: false, msg: '房间不存在' });
    if (room.hostId !== currentUserId) return callback({ success: false, msg: '只有房主可以添加机器人' });
    if (room.status === 'playing') return callback({ success: false, msg: '游戏进行中无法添加' });

    const addCount = Math.min(count || 1, room.maxPlayers - room.players.length);
    if (addCount <= 0) return callback({ success: false, msg: '房间已满' });

    const addedAIs = [];
    for (let i = 0; i < addCount; i++) {
      const aiUserId = 'ai_' + uuidv4();
      const aiName = generateAIName();
      const aiAvatar = generateAIAvatar();
      room.players.push({
        userId: aiUserId,
        username: aiName,
        avatar: aiAvatar,
        money: room.initialMoney,
        isHost: false,
        cards: [],
        niuResult: null,
        isReady: false,
        disconnected: false,
        isAI: true
      });
      addedAIs.push({ userId: aiUserId, username: aiName, avatar: aiAvatar });
    }

    io.to(roomId).emit('roomUpdated', getRoomInfo(room));
    callback({ success: true, addedAIs });
  });

  // 移除AI机器人
  socket.on('removeAI', ({ roomId, aiUserId }, callback) => {
    if (!currentUserId) return callback({ success: false, msg: '请先登录' });
    const room = rooms.get(roomId);
    if (!room) return callback({ success: false, msg: '房间不存在' });
    if (room.hostId !== currentUserId) return callback({ success: false, msg: '只有房主可以移除机器人' });
    if (room.status === 'playing') return callback({ success: false, msg: '游戏进行中无法移除' });

    const idx = room.players.findIndex(p => p.userId === aiUserId && p.isAI);
    if (idx === -1) return callback({ success: false, msg: '未找到该机器人' });

    room.players.splice(idx, 1);
    io.to(roomId).emit('roomUpdated', getRoomInfo(room));
    callback({ success: true });
  });

  // 加入房间
  socket.on('joinRoom', ({ roomId, password }, callback) => {
    if (!currentUserId) return callback({ success: false, msg: '请先登录' });
    const room = rooms.get(roomId);
    if (!room) return callback({ success: false, msg: '房间不存在' });
    if (room.players.length >= room.maxPlayers) return callback({ success: false, msg: '房间已满' });
    if (room.status === 'playing') return callback({ success: false, msg: '游戏进行中，请稍后加入' });
    if (room.password && room.password !== password) return callback({ success: false, msg: '房间密码错误' });

    // 检查是否已经在房间中
    const already = room.players.find(p => p.userId === currentUserId);
    if (already) {
      already.disconnected = false;
      currentRoomId = roomId;
      socket.join(roomId);
      return callback({ success: true, room: getRoomInfo(room) });
    }

    const user = users.get(currentUserId);
    room.players.push({
      userId: currentUserId,
      username: user.username,
      avatar: user.avatar,
      money: room.initialMoney,
      isHost: false,
      cards: [],
      niuResult: null,
      isReady: false,
      disconnected: false,
      isAI: false
    });
    currentRoomId = roomId;
    socket.join(roomId);
    io.to(roomId).emit('roomUpdated', getRoomInfo(room));
    callback({ success: true, room: getRoomInfo(room) });
  });

  // 离开房间
  socket.on('leaveRoom', (callback) => {
    if (!currentRoomId || !currentUserId) return;
    leaveRoom(currentUserId, currentRoomId);
    if (callback) callback({ success: true });
  });

  function leaveRoom(userId, roomId) {
    const room = rooms.get(roomId);
    if (!room) return;
    if (room.status === 'playing') {
      const p = room.players.find(x => x.userId === userId);
      if (p) p.disconnected = true;
      // 检查是否还有在线真人
      checkRoomAlive(room);
      return;
    }
    const idx = room.players.findIndex(x => x.userId === userId);
    if (idx === -1) return;
    room.players.splice(idx, 1);

    if (room.players.length === 0) {
      rooms.delete(roomId);
      return;
    }
    // 如果房主离开，转给第一个玩家
    if (room.hostId === userId) {
      room.hostId = room.players[0].userId;
      room.hostName = room.players[0].username;
      room.players.forEach(p => { p.isHost = (p.userId === room.hostId); });
    }
    io.to(roomId).emit('roomUpdated', getRoomInfo(room));
  }

  // 检查房间是否还有在线真人，如果没有则销毁
  function checkRoomAlive(room) {
    const onlineHumans = room.players.filter(p => !p.isAI && !p.disconnected);
    if (onlineHumans.length === 0) {
      // 所有真人离线，销毁房间
      console.log(`房间 ${room.roomId} 所有真人离线，自动销毁`);
      rooms.delete(room.roomId);
    }
  }

  // 获取房间信息
  socket.on('getRoomInfo', ({ roomId }, callback) => {
    const room = rooms.get(roomId);
    if (!room) return callback({ success: false, msg: '房间不存在' });
    callback({ success: true, room: getRoomInfo(room) });
  });

  // 房主设置
  socket.on('hostSettings', ({ roomId, initialMoney, kickUserId }, callback) => {
    if (!currentUserId) return callback({ success: false, msg: '请先登录' });
    const room = rooms.get(roomId);
    if (!room) return callback({ success: false, msg: '房间不存在' });
    if (room.hostId !== currentUserId) return callback({ success: false, msg: '只有房主可以操作' });

    if (initialMoney !== undefined) {
      room.initialMoney = initialMoney;
      room.players.forEach(p => { if (p.money <= 0) p.money = initialMoney; });
    }
    if (kickUserId) {
      const idx = room.players.findIndex(p => p.userId === kickUserId);
      if (idx !== -1) {
        room.players.splice(idx, 1);
        const sId = userSocketMap.get(kickUserId);
        if (sId) {
          io.to(sId).emit('kicked');
        }
      }
    }
    io.to(roomId).emit('roomUpdated', getRoomInfo(room));
    callback({ success: true });
  });

  // 开始游戏
  socket.on('startGame', ({ roomId }, callback) => {
    if (!currentUserId) return callback({ success: false, msg: '请先登录' });
    const room = rooms.get(roomId);
    if (!room) return callback({ success: false, msg: '房间不存在' });
    if (room.hostId !== currentUserId) return callback({ success: false, msg: '只有房主可以开始游戏' });
    if (room.players.length < 2) return callback({ success: false, msg: '至少需要2名玩家' });
    if (room.status === 'playing') return callback({ success: false, msg: '游戏已开始' });

    startRound(room);
    callback({ success: true });
  });

  function startRound(room) {
    room.status = 'playing';
    room.round++;
    const deck = shuffleDeck(createDeck());

    // 重置玩家状态
    room.players.forEach((p, i) => {
      p.cards = [];
      p.niuResult = null;
      p.isReady = false;
      if (p.money <= 0) p.money = room.initialMoney;
    });

    // 每人发5张牌
    for (let i = 0; i < 5; i++) {
      room.players.forEach(p => {
        p.cards.push(deck.pop());
      });
    }

    // 计算牛型
    room.players.forEach(p => {
      p.niuResult = calculateNiu(p.cards);
    });

    // 通知开始发牌动画
    io.to(room.roomId).emit('gameStarted', {
      round: room.round,
      dealerIndex: room.dealerIndex,
      players: room.players.map(p => ({
        userId: p.userId,
        username: p.username,
        avatar: p.avatar,
        money: p.money,
        isHost: p.isHost,
        cards: p.cards // 只发给自己的在后面
      }))
    });

    // 发牌延迟后发每个人的牌
    setTimeout(() => {
      room.players.forEach(p => {
        const sId = userSocketMap.get(p.userId);
        if (sId) {
          io.to(sId).emit('dealCards', {
            cards: p.cards,
            niuResult: p.niuResult,
            userId: p.userId
          });
        }
      });

      // 通知所有人的公牌信息
      setTimeout(() => {
        // 3秒后自动比牌结算
        setTimeout(() => {
          settleRound(room);
        }, 5000);
      }, 1000);
    }, 1500);
  }

  function settleRound(room) {
    const dealer = room.players[room.dealerIndex];
    const results = [];

    room.players.forEach(p => {
      if (p.userId === dealer.userId) return;
      const cmp = compareHands(
        { cards: p.cards, niuResult: p.niuResult },
        { cards: dealer.cards, niuResult: dealer.niuResult }
      );
      let amount = 0;
      let win = false;
      if (cmp > 0) {
        // 玩家赢
        amount = Math.min(p.niuResult.multiplier, p.money, dealer.money);
        p.money += amount;
        dealer.money -= amount;
        win = true;
      } else {
        // 庄家赢
        amount = Math.min(dealer.niuResult.multiplier, p.money, dealer.money);
        p.money -= amount;
        dealer.money += amount;
        win = false;
      }
      results.push({
        userId: p.userId,
        username: p.username,
        win,
        amount,
        cards: p.cards,
        niuResult: p.niuResult
      });
    });

    const settleData = {
      dealerCards: dealer.cards,
      dealerNiu: dealer.niuResult,
      dealerMoney: dealer.money,
      results,
      players: room.players.map(p => ({ userId: p.userId, username: p.username, money: p.money, avatar: p.avatar }))
    };

    io.to(room.roomId).emit('settle', settleData);

    // 5轮换庄家
    setTimeout(() => {
      room.status = 'waiting';
      if (room.round % 5 === 0) {
        room.dealerIndex = (room.dealerIndex + 1) % room.players.length;
      }
      // 移除破产玩家的信息更新
      io.to(room.roomId).emit('roundEnd', {
        dealerIndex: room.dealerIndex,
        players: room.players.map(p => ({
          userId: p.userId,
          username: p.username,
          avatar: p.avatar,
          money: p.money,
          isHost: p.isHost
        }))
      });
    }, 6000);
  }

  // 获取用户信息
  socket.on('getUserInfo', (callback) => {
    if (!currentUserId) return callback({ success: false });
    const user = users.get(currentUserId);
    if (!user) return callback({ success: false });
    callback({ success: true, user: { userId: user.userId, username: user.username, avatar: user.avatar } });
  });

  // 断开连接
  socket.on('disconnect', () => {
    console.log('用户断开:', socket.id);
    if (currentUserId) {
      userSocketMap.delete(currentUserId);
      if (currentRoomId) {
        const room = rooms.get(currentRoomId);
        if (room) {
          const p = room.players.find(x => x.userId === currentUserId);
          if (p && !p.isAI) {
            p.disconnected = true;
            // 如果房间在等待状态，直接移除玩家
            if (room.status === 'waiting') {
              leaveRoom(currentUserId, currentRoomId);
            } else {
              checkRoomAlive(room);
            }
          }
        }
      }
    }
  });
});

function getRoomInfo(room) {
  return {
    roomId: room.roomId,
    roomName: room.roomName,
    hostId: room.hostId,
    hostName: room.hostName,
    maxPlayers: room.maxPlayers,
    hasPassword: !!room.password,
    initialMoney: room.initialMoney,
    round: room.round,
    status: room.status,
    dealerIndex: room.dealerIndex,
    players: room.players.map(p => ({
      userId: p.userId,
      username: p.username,
      avatar: p.avatar,
      money: p.money,
      isHost: p.isHost,
      disconnected: p.disconnected,
      isAI: p.isAI || false
    }))
  };
}

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`斗牛游戏服务器已启动: http://localhost:${PORT}`);
});
