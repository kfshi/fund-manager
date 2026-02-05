const express = require('express');
const axios = require('axios');
const cors = require('cors');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

const JWT_SECRET = 'my_super_secret_key_2026'; 
const pool = new Pool({
    connectionString: process.env.DATABASE_URL, 
    ssl: { rejectUnauthorized: false } // 云数据库必须加这个 SSL 配置
});

function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return res.status(401).json({ success: false, message: '请先登录' });

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.status(403).json({ success: false, message: '令牌无效' });
        req.user = user;
        next();
    });
}

// 代理设置 (可选)
// process.env.HTTP_PROXY = 'http://127.0.0.1:7890';
// process.env.HTTPS_PROXY = 'http://127.0.0.1:7890';

async function fetchFundEstimate(fundCode) {
    try {
        const timestamp = new Date().getTime();
        const url = `http://fundgz.1234567.com.cn/js/${fundCode}.js?rt=${timestamp}`;
        const response = await axios.get(url, { timeout: 3000 });
        const jsonMatch = response.data.match(/jsonpgz\((.*?)\)/);
        if (jsonMatch && jsonMatch[1]) {
            const result = JSON.parse(jsonMatch[1]);
            return {
                name: result.name,
                est_val: result.gsz,
                est_rate: result.gszzl,
                nav: result.dwjz
            };
        }
        return null;
    } catch (error) { return null; }
}

// ================= 核心接口 =================

// 1. 注册
app.post('/api/register', async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ message: '账号密码不能为空' });
    try {
        const userCheck = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
        if (userCheck.rows.length > 0) return res.status(400).json({ message: '该邮箱已被注册' });
        const hashedPassword = await bcrypt.hash(password, 10);
        // 默认昵称就是邮箱前缀
        const nickname = email.split('@')[0];
        await pool.query('INSERT INTO users (email, password, nickname) VALUES ($1, $2, $3)', [email, hashedPassword, nickname]);
        res.json({ success: true, message: '注册成功' });
    } catch (err) { res.status(500).json({ message: '注册失败' }); }
});

// 2. 登录
app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;
    try {
        const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
        if (result.rows.length === 0) return res.status(400).json({ message: '用户不存在' });
        const user = result.rows[0];
        const validPassword = await bcrypt.compare(password, user.password);
        if (!validPassword) return res.status(400).json({ message: '密码错误' });
        const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '24h' });
        res.json({ success: true, token, email: user.email });
    } catch (err) { res.status(500).json({ message: '登录失败' }); }
});

// 3. 获取列表 (🔥 核心修改：同步更新排行榜数据)
app.get('/api/holdings', authenticateToken, async (req, res) => {
    try {
        const { rows } = await pool.query('SELECT * FROM holdings WHERE user_id = $1 ORDER BY id DESC', [req.user.id]);
        
        let sumTotalProfit = 0;
        let sumDayProfit = 0;

        const list = await Promise.all(rows.map(async (item) => {
            const market = await fetchFundEstimate(item.fund_code);
            let totalProfit = 0;
            let dayProfit = 0;
            let currentVal = item.avg_cost;

            if (market) {
                currentVal = market.est_val;
                totalProfit = (parseFloat(currentVal) - parseFloat(item.avg_cost)) * parseFloat(item.hold_share);
                
                const currentMarketValue = parseFloat(currentVal) * parseFloat(item.hold_share);
                const rate = parseFloat(market.est_rate);
                if (rate !== 0) {
                     const prevMarketValue = currentMarketValue / (1 + rate / 100);
                     dayProfit = currentMarketValue - prevMarketValue;
                }
            }
            
            // 累加
            sumTotalProfit += totalProfit;
            sumDayProfit += dayProfit;

            return {
                id: item.id,
                code: item.fund_code,
                name: item.fund_name,
                cost: item.avg_cost,
                shares: item.hold_share,
                market: market,
                profit: totalProfit.toFixed(2),
                day_profit: dayProfit.toFixed(2)
            };
        }));

        // 🔥 关键一步：把算好的总收益和当日收益，更新到 users 表
        await pool.query(
            'UPDATE users SET total_profit = $1, day_profit = $2 WHERE id = $3',
            [sumTotalProfit.toFixed(2), sumDayProfit.toFixed(2), req.user.id]
        );

        res.json({ success: true, data: list });
    } catch (err) { res.status(500).json({ success: false }); }
});

// 4. 🔥 新增：获取排行榜
app.get('/api/leaderboard', async (req, res) => {
    const { type } = req.query; // 'day' 或 'total'
    try {
        let orderBy = 'total_profit';
        if (type === 'day') orderBy = 'day_profit';

        // 只取前 50 名，且不返回密码
        const query = `
            SELECT nickname, email, total_profit, day_profit 
            FROM users 
            ORDER BY ${orderBy} DESC 
            LIMIT 50
        `;
        const { rows } = await pool.query(query);
        
        // 简单处理隐私，隐藏邮箱中间部分
        const safeRows = rows.map(u => ({
            ...u,
            email: u.email.replace(/(.{2}).+(.{2}@.+)/, "$1****$2")
        }));

        res.json({ success: true, data: safeRows });
    } catch (err) { res.status(500).json({ success: false }); }
});

// 5. 其他接口 (Add/Delete/Update)
app.post('/api/add', authenticateToken, async (req, res) => {
    const { fundCode, cost, shares } = req.body;
    try {
        const marketData = await fetchFundEstimate(fundCode);
        const fundName = marketData ? marketData.name : '未知基金';
        await pool.query('INSERT INTO holdings (user_id, fund_code, fund_name, avg_cost, hold_share) VALUES ($1, $2, $3, $4, $5)', [req.user.id, fundCode, fundName, cost, shares]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false }); }
});

app.delete('/api/delete/:id', authenticateToken, async (req, res) => {
    try {
        await pool.query('DELETE FROM holdings WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false }); }
});

app.put('/api/update/:id', authenticateToken, async (req, res) => {
    const { cost, shares } = req.body;
    try {
        await pool.query('UPDATE holdings SET avg_cost = $1, hold_share = $2 WHERE id = $3 AND user_id = $4', [cost, shares, req.params.id, req.user.id]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false }); }
});

const PORT = process.env.PORT || 3000; // 优先使用云平台分配的端口
app.listen(PORT, () => {
    console.log(`Backend server running on port ${PORT}`);
});