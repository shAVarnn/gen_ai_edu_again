# AI Education Helper

## Project Overview

This web application demonstrates the use of Generative AI (Google Gemini API) to create interactive learning tools for secondary school and early university students. It provides features across various subjects like Physics, Chemistry, Biology, History, and Geography to aid understanding, revision, and engagement.

Developed by: `[ATUL KUMAR/GitHub Username -> shAVrann]`

## Features

- **User Authentication:** Secure user registration and login system using Flask-Login and password hashing.
- **Subject-Specific Pages:** Dedicated sections for different subjects.
- **AI-Powered Tools:**
  - **Summarization:** Summarizes pasted text or uploaded documents (.txt, .pdf).
  - **Quiz Generation:** Creates interactive multiple-choice quizzes based on topic/text, with selectable difficulty and question count. Includes scoring and feedback.
  - **Visualization Aid:** Generates descriptive text to help students visualize abstract concepts.
  - **History Battle Flow:** Explains the sequence of events leading up to selected historical battles.
  - **Geography Map:** Visualizes geographical topics on an interactive Leaflet map, showing relevant locations and descriptions, including bounding box fitting.
  - **Crossword Helper:** Suggests relevant words and clues based on a topic/text for creating crossword puzzles.
  - **Descriptive Writing Feedback:** Provides AI-driven feedback on student's written answers to specific questions/topics (accepts text or file upload).
  - **Real-World Examples:** Generates relatable real-world applications for scientific concepts.
- **Quiz History:** Logged-in users can view their past quiz attempts and scores.
- **Text-to-Speech:** Reads generated content (summaries, feedback, examples) aloud using the browser's Web Speech API.

## Technologies Used

- **Backend:**
  - Python 3.8+
  - Flask (Web Framework)
  - Flask-SQLAlchemy (ORM for Database Interaction)
  - Flask-Login (User Session Management)
  - Flask-WTF (Web Forms & CSRF Protection)
  - Werkzeug (Password Hashing)
  - google-generativeai (Google Gemini API Client)
  - python-dotenv (Environment Variable Management)
  - pypdf (PDF Text Extraction)
  - SQLite (Database)
- **Frontend:**
  - HTML5
  - CSS3
  - JavaScript (ES6+)
  - Fetch API (AJAX)
  - Leaflet.js (Interactive Maps)
  - Web Speech API (Text-to-Speech)
- **AI Model:** Google Gemini (specifically tested with `gemini-1.5-flash`)
- **Development:**
  - Virtual Environment (`venv`)
  - pip (Package Installer)
  - Git / GitHub (Version Control)

## Setup and Installation

1.  **Clone the Repository:**

    ```bash
    git clone https://github.com/shAVarnn/gen_ai_edu_again.git
    cd [Your Repository Name]
    ```

2.  **Create and Activate Virtual Environment:**

    ```bash
    # Create venv
    python -m venv venv
    # Activate (Linux/macOS)
    source venv/bin/activate
    # Activate (Windows CMD/PowerShell)
    .\venv\Scripts\activate
    ```

3.  **Install Dependencies:**

    ```bash
    pip install -r requirements.txt
    ```

4.  **Set Up Environment Variables:**

    - Create a file named `.env` in the project root directory.
    - Add your Google Gemini API key and a secret key for Flask:
      ```env
      # .env file
      GEMINI_API_KEY=YOUR_GEMINI_API_KEY_HERE
      SECRET_KEY=YOUR_FLASK_SECRET_KEY_HERE           # Generate using: python -c "import os; print(os.urandom(24).hex())"
      SQLALCHEMY_DATABASE_URI=sqlite:///app.db
      ```
    - Replace placeholders with your actual keys. **Do not commit the `.env` file to Git.** (Ensure `.env` is listed in your `.gitignore` file).

5.  **Run the Application:**
    ```bash
    flask run
    ```
    The application should now be running, typically at `http://127.0.0.1:5000/`. The first time it runs, it should create the `instance/app.db` SQLite database file.

## Usage

1.  Navigate to the application URL in your web browser.
2.  **Register** a new user account.
3.  **Login** with your registered credentials.
4.  Navigate to the desired **subject page** using the top navigation bar.
5.  Use the different **feature boxes** by providing input (text, files, selections) and clicking the corresponding buttons.
6.  View your **Quiz History** via the link in the navigation bar when logged in.

## Project Structure

.
├── instance/ # SQLite database file (created automatically)
│ └── app.db
├── static/ # Static files (CSS, JS)
│ ├── css/
│ │ └── style.css
│ └── js/
│ └── main.js
├── templates/ # HTML templates (Jinja2)
│ ├── base.html
│ ├── index.html
│ ├── login.html
│ ├── register.html
│ ├── quiz_history.html
│ ├── physics.html
│ ├── history.html
│ ├── geography.html
│ ├── chemistry.html
│ └── biology.html
├── .env # Environment variables (API Key, Secret Key) - DO NOT COMMIT
├── .env.example # Example environment file
├── .gitignore # Specifies intentionally untracked files that Git should ignore
├── app.py # Main Flask application file (routes, logic, models)
├── README.md # This file
└── requirements.txt # Python dependencies

## Future Enhancements

- Flashcard generation feature.
- Explanation variations / Simplifier tool.
- Compare and Contrast feature.
- Saving and viewing history for writing feedback.
- More advanced quiz types (fill-in-the-blank, etc.).
- UI/UX improvements based on feedback.
- Deployment to a web hosting platform (e.g., PythonAnywhere, Heroku, Render).

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request or open an Issue. (Optional: Add contribution guidelines if desired).

## License

Atul Kumar License
