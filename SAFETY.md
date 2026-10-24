# Safety

English | [中文](SAFETY.zh.md)

## AI-Assisted Project

This project is assisted by DeepSeek V4.1-Flash and Qwen 3.8 Max (running on DeepSeek Harness) and GPT 6 Sol (running on Codex). All AI-generated output has not been carefully reviewed by the developers, who are not responsible for the final code base and documentation.

## Experimental Status

Smart Campus Homework Analyzer is an educational technology project under active development. It has not undergone a formal security audit and should not be treated as production-ready software without additional review.

The project can process uploaded student homework files (images, PDFs, Word documents), invoke third-party OCR and LLM APIs, and store data in a local SQLite database. Incorrect model output, misconfiguration, malicious input, or untrusted uploads may produce inaccurate grading results, expose student data, or cause other unintended effects.

## Data & Privacy Considerations

- Student homework, grades, and personal information are sensitive data. Handle them in compliance with applicable privacy regulations.
- API keys for model providers are encrypted at rest using AES-256-GCM on the server. Never commit API keys or `.env` files to version control.
- Uploaded files are stored locally; implement retention and deletion policies appropriate for your jurisdiction.
- Confirm data processing terms with OCR and LLM providers before handling minors' data.
- Teacher review is required before any AI-generated grading result becomes consequential.

## Responsible Use

- Deploy with the least privileges and access scope required.
- Prefer a dedicated environment or virtual machine for testing.
- Keep regular backups of the SQLite database and uploaded files.
- Do not expose the service to untrusted networks without HTTPS, authentication, and rate limiting.
- Review uploaded file types and sizes; validate MIME types on the server.
- Establish administrator approval workflows for teacher accounts.

## No Warranty or Liability

This software is provided without warranty under the [MIT License](LICENSE). To the maximum extent permitted by applicable law, the authors and copyright holders are not responsible for data loss, inaccurate grading, privacy breaches, or other harm arising from use of the project. Use at your own risk.
