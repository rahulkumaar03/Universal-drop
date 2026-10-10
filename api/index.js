// Vercel Serverless Function entry point for UniversalDrop API
process.env.VERCEL = '1';
const { app } = require('../server/app');

module.exports = app;
