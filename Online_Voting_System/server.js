const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const sqlite3 = require('sqlite3').verbose();
const flash = require('express-flash');
const methodOverride = require('method-override');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Database setup
const db = new sqlite3.Database(':memory:');

// Middleware
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static('public'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(methodOverride('_method'));
app.use(session({
  secret: 'voting-system-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false }
}));
app.use(flash());

// Global middleware for user session
app.use((req, res, next) => {
  res.locals.user = req.session.user || null;
  res.locals.messages = req.flash();
  next();
});

// Initialize database
db.serialize(() => {
  // Users table
  db.run(`CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // Polls table
  db.run(`CREATE TABLE polls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT,
    creator_id INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    ends_at DATETIME,
    FOREIGN KEY (creator_id) REFERENCES users (id)
  )`);

  // Poll options table
  db.run(`CREATE TABLE poll_options (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    poll_id INTEGER NOT NULL,
    option_text TEXT NOT NULL,
    vote_count INTEGER DEFAULT 0,
    FOREIGN KEY (poll_id) REFERENCES polls (id)
  )`);

  // Votes table
  db.run(`CREATE TABLE votes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    poll_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    option_id INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (poll_id) REFERENCES polls (id),
    FOREIGN KEY (user_id) REFERENCES users (id),
    FOREIGN KEY (option_id) REFERENCES poll_options (id),
    UNIQUE(poll_id, user_id)
  )`);
});

// Authentication middleware
const requireAuth = (req, res, next) => {
  if (req.session.user) {
    next();
  } else {
    req.flash('error', 'Please log in to access this page');
    res.redirect('/login');
  }
};

// Routes
app.get('/', (req, res) => {
  db.all(`SELECT p.*, u.username as creator_name, 
          (SELECT COUNT(*) FROM votes WHERE poll_id = p.id) as total_votes
          FROM polls p 
          JOIN users u ON p.creator_id = u.id 
          ORDER BY p.created_at DESC LIMIT 10`, (err, polls) => {
    if (err) {
      console.error(err);
      polls = [];
    }
    res.render('home', { polls });
  });
});

// Authentication routes
app.get('/login', (req, res) => {
  res.render('auth/login');
});

app.post('/login', (req, res) => {
  const { email, password } = req.body;
  
  db.get('SELECT * FROM users WHERE email = ?', [email], async (err, user) => {
    if (err || !user) {
      req.flash('error', 'Invalid email or password');
      return res.redirect('/login');
    }
    
    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) {
      req.flash('error', 'Invalid email or password');
      return res.redirect('/login');
    }
    
    req.session.user = user;
    req.flash('success', 'Welcome back!');
    res.redirect('/');
  });
});

app.get('/register', (req, res) => {
  res.render('auth/register');
});

app.post('/register', async (req, res) => {
  const { username, email, password } = req.body;
  
  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    
    db.run('INSERT INTO users (username, email, password) VALUES (?, ?, ?)', 
           [username, email, hashedPassword], function(err) {
      if (err) {
        req.flash('error', 'Username or email already exists');
        return res.redirect('/register');
      }
      
      req.flash('success', 'Registration successful! Please log in.');
      res.redirect('/login');
    });
  } catch (error) {
    req.flash('error', 'Registration failed');
    res.redirect('/register');
  }
});

app.post('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/');
});

// Poll routes
app.get('/polls', (req, res) => {
  db.all(`SELECT p.*, u.username as creator_name,
          (SELECT COUNT(*) FROM votes WHERE poll_id = p.id) as total_votes
          FROM polls p 
          JOIN users u ON p.creator_id = u.id 
          ORDER BY p.created_at DESC`, (err, polls) => {
    if (err) {
      console.error(err);
      polls = [];
    }
    res.render('polls/list', { polls });
  });
});

app.get('/polls/create', requireAuth, (req, res) => {
  res.render('polls/create');
});

app.post('/polls', requireAuth, (req, res) => {
  const { title, description, options } = req.body;
  const optionsArray = Array.isArray(options) ? options : [options];
  
  db.run('INSERT INTO polls (title, description, creator_id) VALUES (?, ?, ?)',
         [title, description, req.session.user.id], function(err) {
    if (err) {
      req.flash('error', 'Failed to create poll');
      return res.redirect('/polls/create');
    }
    
    const pollId = this.lastID;
    const stmt = db.prepare('INSERT INTO poll_options (poll_id, option_text) VALUES (?, ?)');
    
    optionsArray.forEach(option => {
      if (option.trim()) {
        stmt.run(pollId, option.trim());
      }
    });
    
    stmt.finalize();
    req.flash('success', 'Poll created successfully!');
    res.redirect(`/polls/${pollId}`);
  });
});

app.get('/polls/:id', (req, res) => {
  const pollId = req.params.id;
  
  db.get(`SELECT p.*, u.username as creator_name FROM polls p 
          JOIN users u ON p.creator_id = u.id WHERE p.id = ?`, [pollId], (err, poll) => {
    if (err || !poll) {
      req.flash('error', 'Poll not found');
      return res.redirect('/polls');
    }
    
    db.all('SELECT * FROM poll_options WHERE poll_id = ? ORDER BY id', [pollId], (err, options) => {
      if (err) {
        options = [];
      }
      
      let userVote = null;
      if (req.session.user) {
        db.get('SELECT option_id FROM votes WHERE poll_id = ? AND user_id = ?', 
               [pollId, req.session.user.id], (err, vote) => {
          userVote = vote ? vote.option_id : null;
          res.render('polls/view', { poll, options, userVote });
        });
      } else {
        res.render('polls/view', { poll, options, userVote });
      }
    });
  });
});

app.post('/polls/:id/vote', requireAuth, (req, res) => {
  const pollId = req.params.id;
  const optionId = req.body.option_id;
  const userId = req.session.user.id;
  
  // Check if user already voted
  db.get('SELECT * FROM votes WHERE poll_id = ? AND user_id = ?', [pollId, userId], (err, existingVote) => {
    if (existingVote) {
      req.flash('error', 'You have already voted in this poll');
      return res.redirect(`/polls/${pollId}`);
    }
    
    // Insert vote
    db.run('INSERT INTO votes (poll_id, user_id, option_id) VALUES (?, ?, ?)',
           [pollId, userId, optionId], (err) => {
      if (err) {
        req.flash('error', 'Failed to record vote');
        return res.redirect(`/polls/${pollId}`);
      }
      
      // Update vote count
      db.run('UPDATE poll_options SET vote_count = vote_count + 1 WHERE id = ?', [optionId], (err) => {
        if (err) {
          console.error('Failed to update vote count:', err);
        }
        req.flash('success', 'Your vote has been recorded!');
        res.redirect(`/polls/${pollId}`);
      });
    });
  });
});

app.get('/my-polls', requireAuth, (req, res) => {
  db.all(`SELECT p.*, 
          (SELECT COUNT(*) FROM votes WHERE poll_id = p.id) as total_votes
          FROM polls p 
          WHERE p.creator_id = ? 
          ORDER BY p.created_at DESC`, [req.session.user.id], (err, polls) => {
    if (err) {
      console.error(err);
      polls = [];
    }
    res.render('polls/my-polls', { polls });
  });
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});