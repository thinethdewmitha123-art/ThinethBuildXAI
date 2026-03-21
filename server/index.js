/**
 * BuildX AI – Express Backend Server
 * Provides REST API for auth, users, projects, and admin operations.
 */
import express from 'express';
import cors from 'cors';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import multer from 'multer';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';

import {
    createUser, getUserByEmail, getUserById, getAllUsers, updateUser, deleteUser,
    createProject, getProjectById, getProjectsByUser, getAllProjects, updateProject, deleteProject,
    getDashboardStats
} from './db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET || 'buildx-ai-secret-key-2026';

// ─── Middleware ────────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Serve uploaded photos
const uploadsDir = join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
app.use('/uploads', express.static(uploadsDir));

// Multer config for photo uploads
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadsDir),
    filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`)
});
const upload = multer({ storage, limits: { fileSize: 20 * 1024 * 1024 } });

// ─── Auth Middleware ──────────────────────────────────────────────────────────
function authMiddleware(req, res, next) {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'Authentication required' });
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        const user = getUserById(decoded.userId);
        if (!user) return res.status(401).json({ error: 'User not found' });
        if (user.status === 'suspended') return res.status(403).json({ error: 'Account suspended' });
        req.user = user;
        next();
    } catch (err) {
        return res.status(401).json({ error: 'Invalid or expired token' });
    }
}

function adminMiddleware(req, res, next) {
    if (!req.user?.is_admin) return res.status(403).json({ error: 'Admin access required' });
    next();
}

// ─── Auth Routes ──────────────────────────────────────────────────────────────
app.post('/api/auth/register', (req, res) => {
    try {
        const { name, email, phone, address, password } = req.body;

        if (!name || !email || !password) {
            return res.status(400).json({ error: 'Name, email, and password are required.' });
        }
        if (password.length < 8) {
            return res.status(400).json({ error: 'Password must be at least 8 characters.' });
        }

        const existing = getUserByEmail(email);
        if (existing) {
            return res.status(409).json({ error: 'An account with this email already exists.' });
        }

        const passwordHash = bcrypt.hashSync(password, 10);
        const id = 'user_' + uuidv4().replace(/-/g, '').substring(0, 12);
        const isAdmin = email === 'admin@buildx.ai' ? 1 : 0;

        const user = createUser({ id, name, email, phone, address, passwordHash });

        // Set admin flag if it's the admin email
        if (isAdmin) updateUser(id, { is_admin: 1 });

        const token = jwt.sign({ userId: id }, JWT_SECRET, { expiresIn: '7d' });
        const freshUser = getUserById(id);

        res.status(201).json({
            token,
            user: {
                id: freshUser.id,
                name: freshUser.name,
                email: freshUser.email,
                phone: freshUser.phone,
                address: freshUser.address,
                isAdmin: !!freshUser.is_admin,
                status: freshUser.status,
            }
        });
    } catch (err) {
        console.error('Registration error:', err);
        res.status(500).json({ error: 'Registration failed. Please try again.' });
    }
});

app.post('/api/auth/login', (req, res) => {
    try {
        const { email, password } = req.body;

        if (!email || !password) {
            return res.status(400).json({ error: 'Email and password are required.' });
        }

        const user = getUserByEmail(email);
        if (!user) {
            return res.status(401).json({ error: 'Invalid email or password.' });
        }

        const validPassword = bcrypt.compareSync(password, user.password_hash);
        if (!validPassword) {
            return res.status(401).json({ error: 'Invalid email or password.' });
        }

        if (user.status === 'suspended') {
            return res.status(403).json({ error: 'Your account has been suspended. Please contact support.' });
        }

        const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '7d' });

        res.json({
            token,
            user: {
                id: user.id,
                name: user.name,
                email: user.email,
                phone: user.phone,
                address: user.address,
                isAdmin: !!user.is_admin,
                status: user.status,
            }
        });
    } catch (err) {
        console.error('Login error:', err);
        res.status(500).json({ error: 'Login failed. Please try again.' });
    }
});

app.get('/api/auth/me', authMiddleware, (req, res) => {
    res.json({
        user: {
            id: req.user.id,
            name: req.user.name,
            email: req.user.email,
            phone: req.user.phone,
            address: req.user.address,
            isAdmin: !!req.user.is_admin,
            status: req.user.status,
        }
    });
});

// ─── User Profile Routes ─────────────────────────────────────────────────────
app.put('/api/users/profile', authMiddleware, (req, res) => {
    try {
        const { name, phone, address } = req.body;
        const updated = updateUser(req.user.id, { name, phone, address });
        res.json({ user: updated });
    } catch (err) {
        res.status(500).json({ error: 'Failed to update profile.' });
    }
});

// ─── Project Routes ───────────────────────────────────────────────────────────
app.post('/api/projects', authMiddleware, (req, res) => {
    try {
        const { projectName, specs, aiAnalysis, estimate, photosMeta } = req.body;
        const id = 'proj_' + uuidv4().replace(/-/g, '').substring(0, 12);
        const project = createProject({
            id,
            userId: req.user.id,
            projectName,
            specs,
            aiAnalysis,
            estimate,
            photosMeta
        });
        res.status(201).json({ project });
    } catch (err) {
        console.error('Create project error:', err);
        res.status(500).json({ error: 'Failed to save project.' });
    }
});

app.get('/api/projects', authMiddleware, (req, res) => {
    try {
        const projects = getProjectsByUser(req.user.id);
        res.json({ projects });
    } catch (err) {
        res.status(500).json({ error: 'Failed to load projects.' });
    }
});

app.get('/api/projects/:id', authMiddleware, (req, res) => {
    try {
        const project = getProjectById(req.params.id);
        if (!project) return res.status(404).json({ error: 'Project not found.' });
        // Users can only view their own projects, admins can view all
        if (project.user_id !== req.user.id && !req.user.is_admin) {
            return res.status(403).json({ error: 'Access denied.' });
        }
        res.json({ project });
    } catch (err) {
        res.status(500).json({ error: 'Failed to load project.' });
    }
});

app.put('/api/projects/:id', authMiddleware, (req, res) => {
    try {
        const project = getProjectById(req.params.id);
        if (!project) return res.status(404).json({ error: 'Project not found.' });
        if (project.user_id !== req.user.id && !req.user.is_admin) {
            return res.status(403).json({ error: 'Access denied.' });
        }
        const updated = updateProject(req.params.id, req.body);
        res.json({ project: updated });
    } catch (err) {
        res.status(500).json({ error: 'Failed to update project.' });
    }
});

app.delete('/api/projects/:id', authMiddleware, (req, res) => {
    try {
        const project = getProjectById(req.params.id);
        if (!project) return res.status(404).json({ error: 'Project not found.' });
        if (project.user_id !== req.user.id && !req.user.is_admin) {
            return res.status(403).json({ error: 'Access denied.' });
        }
        deleteProject(req.params.id);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to delete project.' });
    }
});

// Photo upload
app.post('/api/projects/upload-photos', authMiddleware, upload.array('photos', 4), (req, res) => {
    try {
        const photosMeta = req.files.map(f => ({
            filename: f.filename,
            originalName: f.originalname,
            path: `/uploads/${f.filename}`,
            size: f.size,
            mimeType: f.mimetype
        }));
        res.json({ photos: photosMeta });
    } catch (err) {
        res.status(500).json({ error: 'Failed to upload photos.' });
    }
});

// ─── Admin Routes ─────────────────────────────────────────────────────────────
app.get('/api/admin/stats', authMiddleware, adminMiddleware, (req, res) => {
    try {
        const stats = getDashboardStats();
        res.json({ stats });
    } catch (err) {
        res.status(500).json({ error: 'Failed to load stats.' });
    }
});

app.get('/api/admin/users', authMiddleware, adminMiddleware, (req, res) => {
    try {
        const users = getAllUsers();
        res.json({ users: users.map(u => ({ ...u, isAdmin: !!u.is_admin })) });
    } catch (err) {
        res.status(500).json({ error: 'Failed to load users.' });
    }
});

app.get('/api/admin/users/:id', authMiddleware, adminMiddleware, (req, res) => {
    try {
        const user = getUserById(req.params.id);
        if (!user) return res.status(404).json({ error: 'User not found.' });
        const projects = getProjectsByUser(req.params.id);
        res.json({ user: { ...user, isAdmin: !!user.is_admin }, projects });
    } catch (err) {
        res.status(500).json({ error: 'Failed to load user details.' });
    }
});

app.put('/api/admin/users/:id', authMiddleware, adminMiddleware, (req, res) => {
    try {
        const updated = updateUser(req.params.id, req.body);
        res.json({ user: { ...updated, isAdmin: !!updated.is_admin } });
    } catch (err) {
        res.status(500).json({ error: 'Failed to update user.' });
    }
});

app.delete('/api/admin/users/:id', authMiddleware, adminMiddleware, (req, res) => {
    try {
        if (req.params.id === req.user.id) {
            return res.status(400).json({ error: 'Cannot delete your own admin account.' });
        }
        deleteUser(req.params.id);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to delete user.' });
    }
});

app.get('/api/admin/projects', authMiddleware, adminMiddleware, (req, res) => {
    try {
        const projects = getAllProjects();
        res.json({ projects });
    } catch (err) {
        res.status(500).json({ error: 'Failed to load projects.' });
    }
});

app.put('/api/admin/projects/:id', authMiddleware, adminMiddleware, (req, res) => {
    try {
        const updated = updateProject(req.params.id, req.body);
        res.json({ project: updated });
    } catch (err) {
        res.status(500).json({ error: 'Failed to update project.' });
    }
});

app.delete('/api/admin/projects/:id', authMiddleware, adminMiddleware, (req, res) => {
    try {
        deleteProject(req.params.id);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to delete project.' });
    }
});

// ─── Start Server ─────────────────────────────────────────────────────────────
app.listen(PORT, () => {
    console.log(`\n🏗️  BuildX AI Backend running on http://localhost:${PORT}`);
    console.log(`   API: http://localhost:${PORT}/api\n`);
});
