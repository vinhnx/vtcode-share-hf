#!/usr/bin/env node

import { readFileSync } from 'fs';
import { join } from 'path';
import { Command } from 'commander';
import express from 'express';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export class ATIFViewer {
  private app: express.Application;
  private port: number;

  constructor(port: number = 3000) {
    this.port = port;
    this.app = express();
    this.setupRoutes();
  }

  private setupRoutes() {
    this.app.use(express.static(join(__dirname, '..')));

    // Serve the ATIF viewer HTML
    this.app.get('/', (req, res) => {
      res.sendFile(join(__dirname, '..', 'atif-viewer.html'));
    });

    // API endpoint to load trajectory data
    this.app.get('/api/trajectory', (req, res) => {
      const filePath = req.query.file as string;
      if (!filePath) {
        return res.status(400).json({ error: 'File path required' });
      }

      try {
        const data = readFileSync(filePath, 'utf-8');
        const trajectory = JSON.parse(data);
        res.json(trajectory);
      } catch (error) {
        res.status(500).json({ error: `Failed to load trajectory: ${error}` });
      }
    });
  }

  start() {
    this.app.listen(this.port, () => {
      console.log(`🚀 ATIF Trajectory Viewer running at http://localhost:${this.port}`);
      console.log(`📖 Open your browser and load an ATIF trajectory file to begin exploring`);
    });
  }
}

// CLI command
const program = new Command();

program
  .name('atif-viewer')
  .description('Launch ATIF Trajectory Viewer web interface')
  .option('--port <port>', 'Port to run the viewer on', '3000')
  .action((options) => {
    const port = parseInt(options.port);
    const viewer = new ATIFViewer(port);
    viewer.start();
  });

if (import.meta.url === `file://${process.argv[1]}`) {
  program.parse(process.argv);
}