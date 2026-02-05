const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const axios = require('axios');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// 数据库连接
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const JWT_SECRET = process.env.JWT_SECRET || 'secret';

// --- 🔥 核心修复：更智能的基金数据抓取函数 ---
async function fetchFundData(code) {
  let fundData = { name: "未知基金", est_val: "0.00", est_rate: "0.00", update_time: "" };

  try {
    // 1. 尝试从【天天基金实时接口】获取 (包含估值)
    // 使用时间戳防止缓存
    const url = `http://fundgz.1234567.com.cn/js/${code}.js?rt=${Date.now()}`;
    const res = await axios.get(url, { timeout: 3000 }); // 设置3秒超时
    const dataStr = res.data;

    // 解析 JSONP 格式: jsonpgz({...});
    if (dataStr && dataStr.indexOf('jsonpgz(') > -1) {
      const jsonStr = dataStr.slice(8, -2);
      const data = JSON.parse(jsonStr);
      
      fundData.name = data.name;
      fundData.est_val = data.gsz;   // 估算净值
      fundData.est_rate = data.gszzl; // 估算涨幅
      fundData.update_time = data.gztime;
      console.log(`[Success] Realtime fetch for ${code}: ${data.name}`);
    }
  } catch (error) {
    console.log(`[Warning] Realtime API failed for ${code}, trying fallback...`);
  }

  // 2. 双重保险：如果名字还是“未知基金”，尝试从【备用搜索接口】只抓取名字
  if (fundData.name === "未知基金") {
    try {
      // 这是一个更全的基金数据库接口
      const searchUrl = `https://fundsuggest.eastmoney.com/FundSearch/api/FundSearchAPI.ashx?m=1&key=${code}`;
      const searchRes = await axios.get(searchUrl, { timeout: 3000 });
      
      if (searchRes.data && searchRes.data.Datas && searchRes.data.Datas.length > 0) {
        const info = searchRes.data.Datas[0];
        fundData.name = info.NAME; // 强制更正名字
        console.log(`[Fixed] Found name from backup API for ${code}: ${info.NAME}`);
        
        // 如果实时接口挂了，尝试用净值填充估值，避免显示 0.00
        if (fundData.est_val === "0.00" && info.FundBaseInfo) {
           fundData.est_val = info.FundBaseInfo.DWJZ || "0.00";
        }
      }
    } catch (e) {
      console.error(`[Error] All APIs failed for ${code}`);
    }
  }

  return fundData;
}

// --- API 路由 ---

// 1. 注册
app.post('/api/register', async (req, res) => {
  const { email, password } = req.body;
  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    const result = await pool.query(
      'INSERT INTO users (email, password, nickname) VALUES ($1, $2, $3) RETURNING id, email',
      [email, hashedPassword, email.split('@')[0]]
    );
    res.json({ success: true, user: result.rows[0] });
  } catch (err) {
    res.status(400).json({ success: false, message: '注册失败，邮箱可能已存在' });
  }
});

// 2. 登录
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    if (result.rows.length === 0) return res.status(400).json({ message: '用户不存在' });

    const user = result.rows[0];
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(400).json({ message: '密码错误' });

    const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ success: true, token, email: user.email });
  } catch (err) {
    res.status(500).json({ message: '服务器错误' });
  }
});

// 中间件：验证 Token
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.sendStatus(401);

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.sendStatus(403);
    req.user = user;
    next();
  });
};

// 3. 获取持仓列表 (带实时数据)
app.get('/api/holdings', authenticateToken, async (req, res) => {
  try {
    // 获取数据库里的持仓
    const result = await pool.query('SELECT * FROM holdings WHERE user_id = $1 ORDER BY id DESC', [req.user.id]);
    let holdings = result.rows;

    // 实时去爬取最新行情
    const promises = holdings.map(async (item) => {
      const marketData = await fetchFundData(item.fund_code);
      
      // 计算收益
      // 收益 = (最新估值 - 持仓成本) * 持有份额
      const currentVal = parseFloat(marketData.est_val || 0);
      const costVal = parseFloat(item.avg_cost || 0);
      const profit = (currentVal - costVal) * item.hold_share;
      
      // 估算当日收益 = (最新估值 * 估算涨幅%) * 份额 (粗略计算)
      // 更精确的是: 昨日净值 * 涨幅 * 份额。这里简化处理。
      const dayProfit = (currentVal * (parseFloat(marketData.est_rate)/100)) * item.hold_share;

      return {
        ...item,
        name: marketData.name, // 使用爬取到的最新名字
        code: item.fund_code,
        cost: item.avg_cost,
        shares: item.hold_share,
        market: marketData,
        profit: profit.toFixed(2),
        day_profit: dayProfit.toFixed(2)
      };
    });

    const data = await Promise.all(promises);

    // 顺便更新一下用户的总收益统计，用于排行榜
    const totalProfit = data.reduce((acc, cur) => acc + parseFloat(cur.profit), 0);
    const totalDayProfit = data.reduce((acc, cur) => acc + parseFloat(cur.day_profit), 0);
    
    await pool.query('UPDATE users SET total_profit = $1, day_profit = $2 WHERE id = $3', 
      [totalProfit, totalDayProfit, req.user.id]);

    res.json({ success: true, data });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: '获取数据失败' });
  }
});

// 4. 添加持仓
app.post('/api/add', authenticateToken, async (req, res) => {
  const { fundCode, cost, shares } = req.body;
  try {
    // 添加时先去查一下名字
    const marketData = await fetchFundData(fundCode);
    
    await pool.query(
      'INSERT INTO holdings (user_id, fund_code, fund_name, avg_cost, hold_share) VALUES ($1, $2, $3, $4, $5)',
      [req.user.id, fundCode, marketData.name, cost, shares]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: '添加失败' });
  }
});

// 5. 修改持仓
app.put('/api/update/:id', authenticateToken, async (req, res) => {
  const { fundCode, cost, shares } = req.body;
  try {
    // 修改时也更新一下名字（万一之前是未知的）
    const marketData = await fetchFundData(fundCode);
    
    await pool.query(
      'UPDATE holdings SET fund_code=$1, avg_cost=$2, hold_share=$3, fund_name=$4 WHERE id=$5 AND user_id=$6',
      [fundCode, cost, shares, marketData.name, req.params.id, req.user.id]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false });
  }
});

// 6. 删除持仓
app.delete('/api/delete/:id', authenticateToken, async (req, res) => {
  try {
    await pool.query('DELETE FROM holdings WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false });
  }
});

// 7. 排行榜接口
app.get('/api/leaderboard', async (req, res) => {
  const type = req.query.type || 'day'; // 'day' or 'total'
  const field = type === 'day' ? 'day_profit' : 'total_profit';
  
  try {
    const result = await pool.query(
      `SELECT email, nickname, total_profit, day_profit FROM users ORDER BY ${field} DESC LIMIT 10`
    );
    res.json({ success: true, data: result.rows });
  } catch (err) {
    res.status(500).json({ success: false });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});