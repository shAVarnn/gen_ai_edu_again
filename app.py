import google.generativeai as genai
import os
import logging
import json
from datetime import datetime
from flask import Flask, render_template, request, jsonify, abort, url_for
from dotenv import load_dotenv

from flask_sqlalchemy import SQLAlchemy
from flask_login import LoginManager, UserMixin, login_user, logout_user, current_user, login_required
from flask_wtf import FlaskForm
from wtforms import StringField, PasswordField, BooleanField, SubmitField
from wtforms.validators import DataRequired, Length, Email, EqualTo, ValidationError
from werkzeug.security import generate_password_hash, check_password_hash
from flask import flash, redirect
from flask import session
import io
from pypdf import PdfReader

# --- NEW Langchain and FAISS imports ---
from langchain.text_splitter import RecursiveCharacterTextSplitter
from langchain_google_genai import GoogleGenerativeAIEmbeddings
from langchain_community.vectorstores import FAISS
from langchain_google_genai import ChatGoogleGenerativeAI
from langchain.prompts import PromptTemplate
from langchain.chains.question_answering import load_qa_chain
import hashlib # For generating unique IDs for PDFs
import shutil # For cleaning up old indexes

from flask_limiter import Limiter
from flask_limiter.util import get_remote_address



# --- Basic Setup ---
load_dotenv()               # For loading environment variables from .env file
API_KEY = os.getenv('GEMINI_API_KEY')

if not API_KEY:
    raise ValueError("GEMINI_API_KEY not found in .env file. Please create a .env file and add your API key.")

try:
    genai.configure(api_key=API_KEY)
    # We'll use a model suitable for various tasks (text, chat, JSON),for now i m using gemini 1.5 flash free
    # gemini-1.5-flash is generally faster and cheaper for many tasks.
    model = genai.GenerativeModel('gemini-1.5-flash')
    logging.info("Gemini API configured successfully.")
except Exception as e:
    logging.exception(f"Error configuring Gemini API: {e}")
    raise

app = Flask(__name__)


# Loading Secret Key from .env
app.config['SECRET_KEY'] = os.getenv('SECRET_KEY')
if not app.config['SECRET_KEY']:
    raise ValueError("SECRET_KEY not found in .env file. Please generate one and add it.")

# Configureing Database
# Use the URI from .env, defaulting to 'instance/app.db' if not set (for safety)
app.config['SQLALCHEMY_DATABASE_URI'] = os.getenv('SQLALCHEMY_DATABASE_URI', 'sqlite:///app.db')
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False # Optional: Disable modification tracking

# Initialize Database ORM
db = SQLAlchemy(app)


# === NEW: Initialize Flask-Limiter ===
# The key_func determines what identifies a "user" (e.g., IP address).
limiter = Limiter(
    get_remote_address,
    app=app,
    default_limits=["200 per day", "60 per hour"], # General limits for all routes
    storage_uri="memory://", # Simple in-memory storage. For production, consider Redis.
)
# === END NEW ---

# Initialize Login Manager
login_manager = LoginManager(app)
login_manager.login_view = 'login' # The route name (function name) for the login page
login_manager.login_message_category = 'info' # Flash message category
login_manager.login_message = 'Please log in to access this page.'

# --- ENDING NEW CONFIGURATION ---


# Define the User model for the database
class User(db.Model, UserMixin):
    id = db.Column(db.Integer, primary_key=True)
    email = db.Column(db.String(120), unique=True, nullable=False)
    password_hash = db.Column(db.String(128), nullable=False) # Store hash, not password
    # Add the relationship to QuizAttempt
    quiz_attempts = db.relationship('QuizAttempt', backref='attempt_user', lazy=True, cascade="all, delete-orphan") # 'attempt_user' lets us access user from attempt


    def __repr__(self):
        return f"User('{self.email}')"

    def set_password(self, password):
        """Creates password hash."""
        self.password_hash = generate_password_hash(password)

    def check_password(self, password):
        """Checks password hash."""
        return check_password_hash(self.password_hash, password)

# Add after the User class definition in app.py
class QuizAttempt(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False) # Foreign key to User table
    timestamp = db.Column(db.DateTime, nullable=False, default=datetime.utcnow)
    subject = db.Column(db.String(50), nullable=False)
    score = db.Column(db.Integer, nullable=False)
    total_questions = db.Column(db.Integer, nullable=False)
    # Store original quiz and user answers as JSON strings in Text fields
    # Alternatively, use db.JSON if your specific SQLite version supports it well with Flask-SQLAlchemy
    quiz_data = db.Column(db.Text, nullable=False)
    user_answers = db.Column(db.Text, nullable=False)

    def __repr__(self):
        return f"QuizAttempt(User ID: {self.user_id}, Subject: {self.subject}, Score: {self.score}/{self.total_questions}, Time: {self.timestamp})"


@login_manager.user_loader
def load_user(user_id):
    """Loads user from the database based on user_id stored in session."""
    return User.query.get(int(user_id))

# We should add after the load_user function 

# --- Forms Definition ---

class RegistrationForm(FlaskForm):
    email = StringField('Email', validators=[DataRequired(), Email()])
    password = PasswordField('Password', validators=[DataRequired(), Length(min=8)])
    confirm_password = PasswordField('Confirm Password',
                                     validators=[DataRequired(), EqualTo('password', message='Passwords must match.')])
    submit = SubmitField('Register')

    def validate_email(self, email):
        """Checks if email already exists in the database."""
        user = User.query.filter_by(email=email.data.lower()).first() # Check lowercase email
        if user:
            raise ValidationError('That email is already registered. Please choose a different one or log in.')

class LoginForm(FlaskForm):
    email = StringField('Email', validators=[DataRequired(), Email()])
    password = PasswordField('Password', validators=[DataRequired()])
    remember = BooleanField('Remember Me')
    submit = SubmitField('Login')




# Configure logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')

# --- Context Processor to pass year to all templates ---
@app.context_processor
def inject_current_year():
    return {'current_year': datetime.utcnow().year}


# Add before the API endpoint routes in app.py
# Need to import flash and redirect at the top
# from flask import flash, redirect, url_for


# --- Configuration for PDF Q&A ---
FAISS_INDEX_DIR = os.path.join(app.instance_path, "faiss_indexes")
if not os.path.exists(FAISS_INDEX_DIR):
    os.makedirs(FAISS_INDEX_DIR)
    logging.info(f"Created FAISS index directory: {FAISS_INDEX_DIR}")



# --- Langchain Helper Functions ---

def get_pdf_text_from_file_storage(pdf_file_storage):
    text = ""
    try:
        pdf_stream = io.BytesIO(pdf_file_storage.read())
        pdf_reader = PdfReader(pdf_stream)
        if pdf_reader.is_encrypted:
            try: pdf_reader.decrypt('')
            except Exception: logging.warning(f"Could not decrypt PDF {pdf_file_storage.filename}")
        for page in pdf_reader.pages:
            page_text = page.extract_text()
            if page_text: text += page_text + "\n"
    except Exception as e:
        logging.error(f"Error reading PDF file {pdf_file_storage.filename}: {e}")
        raise
    return text


def get_text_chunks_langchain(text):
    text_splitter = RecursiveCharacterTextSplitter(chunk_size=10000, chunk_overlap=1000)
    chunks = text_splitter.split_text(text)
    return chunks

def create_and_save_vector_store(text_chunks, index_path):
    """Creates a FAISS vector store from text chunks and saves it locally."""
    try:
        embeddings = GoogleGenerativeAIEmbeddings(
            model="models/embedding-001",
            google_api_key=API_KEY 
        )

        vector_store = FAISS.from_texts(text_chunks, embedding=embeddings)
        vector_store.save_local(index_path)
        logging.info(f"FAISS vector store saved to: {index_path}")
    except Exception as e:
        logging.error(f"Error creating/saving vector store at {index_path}: {e}")
        raise

def get_conversational_qa_chain():
    """Loads and returns a Langchain QA chain with a specific prompt."""
    prompt_template = """
    You are an AI assistant tasked with answering questions based ONLY on the provided context from a document.
    Read the context carefully. If the answer is found within the context, provide a clear and concise answer.
    If the answer cannot be found in the provided context, you MUST explicitly state: "The answer is not found in the provided document."
    Do NOT use any external knowledge or make assumptions beyond the given text.
    Do NOT attempt to search the internet. Your knowledge is strictly limited to the document context.

    Context:
    {context}

    Question:
    {question}

    Answer based ONLY on the context:
    """

    llm_model = ChatGoogleGenerativeAI(
        model="gemini-1.5-flash",
        temperature=0.3,
        google_api_key=API_KEY # Use the API_KEY loaded from .env
    )

    prompt = PromptTemplate(template=prompt_template, input_variables=["context", "question"])
    chain = load_qa_chain(llm_model, chain_type="stuff", prompt=prompt)
    return chain

# --- END Langchain Helper Functions ---



# --- Authentication Routes ---

@app.route('/register', methods=['GET', 'POST'])
def register():
    """Handles user registration."""
    if current_user.is_authenticated:
        return redirect(url_for('index')) # Redirect if already logged in

    form = RegistrationForm()
    if form.validate_on_submit(): # Checks if POST request and form is valid
        try:
            hashed_password = generate_password_hash(form.password.data)
            user = User(email=form.email.data.lower(), password_hash=hashed_password)
            db.session.add(user)
            db.session.commit()
            flash('Your account has been created! You can now log in.', 'success')
            logging.info(f"New user registered: {form.email.data.lower()}")
            return redirect(url_for('login'))
        except Exception as e:
            db.session.rollback() # Rollback in case of error
            logging.exception(f"Error during registration for {form.email.data.lower()}: {e}")
            flash('An error occurred during registration. Please try again.', 'danger')

    return render_template('register.html', title='Register', form=form)


@app.route('/login', methods=['GET', 'POST'])
def login():
    """Handles user login."""
    if current_user.is_authenticated:
        return redirect(url_for('index')) # Redirect if already logged in

    form = LoginForm()
    if form.validate_on_submit():
        user = User.query.filter_by(email=form.email.data.lower()).first()
        if user and check_password_hash(user.password_hash, form.password.data):
            login_user(user, remember=form.remember.data)
            # Redirect to the page the user was trying to access, or index
            next_page = request.args.get('next')
            logging.info(f"User logged in: {user.email}")
            flash('Login successful!', 'success')
            return redirect(next_page) if next_page else redirect(url_for('index'))
        else:
            flash('Login Unsuccessful. Please check email and password.', 'danger')
            logging.warning(f"Failed login attempt for: {form.email.data.lower()}")

    return render_template('login.html', title='Login', form=form)


@app.route('/logout')
def logout():
    """Logs the user out."""
    if current_user.is_authenticated:
         logging.info(f"User logged out: {current_user.email}")
         logout_user()
         flash('You have been logged out.', 'info')
    return redirect(url_for('index'))

# --- Routes ---

@app.route('/')
def index():
    """Serves the home page with links to subjects."""
    logging.info("Serving index page.")
    # Define the subjects for which you have templates
    subjects = ['physics', 'history', 'geography','chemistry','biology'] # Can add other subjects if needed
    return render_template('index.html', subjects=subjects)

@app.route('/<subject>')
@login_required
def subject_page(subject):
    """Serves the specific page for a given subject."""
    valid_subjects = ['physics', 'history', 'geography', 'chemistry', 'biology'] # All potential subjects
    template_name = f'{subject}.html'
    template_path = os.path.join(app.template_folder, template_name)

    # Check if subject is valid and if a template file exists for it
    if subject not in valid_subjects or not os.path.exists(template_path):
        logging.warning(f"Subject '{subject}' not found or template '{template_name}' missing.")
        abort(404) # Not Found

    logging.info(f"Serving page for subject: {subject}")
    return render_template(template_name, subject_name=subject.capitalize())



# --- API Endpoints for AI Features ---

@app.route('/generate-summary', methods=['POST'])
@limiter.limit("10 per minute")
def generate_summary():
    """
    Generates a summary from either pasted text (JSON) or an uploaded file (FormData).
    Detects input type based on request Content-Type or a field in the payload.
    """
    logging.info("Received request for /generate-summary (Dual Input)")
    text_to_summarize = ""
    input_source_description = "pasted text" # Default description

    # --- Determine Input Type and Extract Text ---
    try:
        # Check Content-Type first (more reliable for file uploads)
        content_type = request.content_type
        logging.info(f"Request Content-Type: {content_type}")

        if content_type.startswith('multipart/form-data'):
            logging.info("Processing as File Upload (FormData)")
            if 'file' not in request.files:
                raise ValueError("No file part in the request")
            file = request.files['file']
            if file.filename == '':
                raise ValueError("No file selected by the user")

            filename = file.filename
            input_source_description = f"file '{filename}'" # Update description
            allowed_extensions = {'txt', 'pdf'}
            if '.' not in filename or filename.rsplit('.', 1)[1].lower() not in allowed_extensions:
                raise ValueError(f"Invalid file type: {filename}. Only .txt or .pdf allowed.")

            file_extension = filename.rsplit('.', 1)[1].lower()

            if file_extension == 'txt':
                try:
                    text_bytes = file.read()
                    try:
                        text_to_summarize = text_bytes.decode('utf-8')
                    except UnicodeDecodeError:
                         logging.warning(f"UTF-8 decode failed for {filename}, trying latin-1")
                         text_to_summarize = text_bytes.decode('latin-1', errors='ignore')
                    logging.info(f"Successfully read text from {filename}")
                except Exception as e:
                     raise IOError(f"Could not read .txt file: {e}")

            elif file_extension == 'pdf':
                try:
                    pdf_stream = io.BytesIO(file.read())
                    reader = PdfReader(pdf_stream)
                    extracted_pages = []
                    if reader.is_encrypted:
                         # Try decrypting with an empty password, log if it fails
                         try:
                              reader.decrypt('')
                              logging.info(f"Decrypted PDF {filename} with empty password.")
                         except Exception as decrypt_e:
                              logging.warning(f"Could not decrypt PDF {filename}: {decrypt_e}. Extraction might fail.")
                              # Optional: return error if decryption needed but failed
                              # raise IOError(f"PDF file '{filename}' is encrypted and could not be decrypted.")

                    for i, page in enumerate(reader.pages):
                        try:
                            extracted_pages.append(page.extract_text() or "")
                        except Exception as page_e:
                            logging.warning(f"Could not extract text from page {i+1} of {filename}: {page_e}")
                            extracted_pages.append("")
                    text_to_summarize = "\n".join(extracted_pages)
                    logging.info(f"Successfully extracted text from {len(reader.pages)} page(s) in {filename}")
                except Exception as e:
                     logging.exception(f"Error reading PDF file {filename}: {e}")
                     raise IOError(f"Could not process PDF file: {e}")

        elif content_type.startswith('application/json'):
            logging.info("Processing as Text Input (JSON)")
            data = request.get_json()
            if not data or 'text' not in data:
                 raise ValueError("Missing 'text' field in JSON payload")
            text_to_summarize = data.get('text')
            input_source_description = "pasted text"

        else:
            # Fallback or error if content type is unexpected
            logging.error(f"Unsupported Content-Type: {content_type}")
            return jsonify({"error": f"Unsupported request type: {content_type}"}), 415 # Unsupported Media Type

        # Check if text extraction/retrieval yielded any content
        if not text_to_summarize or not isinstance(text_to_summarize, str) or not text_to_summarize.strip():
            logging.warning(f"No text content found from {input_source_description}")
            return jsonify({"error": f"Could not get any text content from {input_source_description}."}), 400

    except (ValueError, IOError) as e: # Catch specific errors from processing
         logging.error(f"Input Processing Error: {e}")
         return jsonify({"error": str(e)}), 400
    except Exception as e: # Catch unexpected errors during input handling
        logging.exception(f"Unexpected error processing input for summary: {e}")
        return jsonify({"error": "An unexpected error occurred processing your input."}), 500

    # --- Text Extracted/Received - Now calling Gemini API ---
    try:
        logging.info(f"Generating summary using Gemini API for content from {input_source_description}...")
        # (Optional text truncation logic can go here)

        prompt = f"Summarize the following text concisely for a secondary school student. Focus on the main points and key information:\n\n---\n{text_to_summarize}\n---"
        response = model.generate_content(prompt)

        # (Keep the same response handling logic as before to extract summary_text and check for blocks/empty results)
        summary_text = ""
        if response.parts: summary_text = response.parts[0].text
        elif hasattr(response, 'text'): summary_text = response.text

        if not summary_text.strip():
             if response.prompt_feedback and response.prompt_feedback.block_reason:
                 # ... (handle block reason) ...
                 block_reason = response.prompt_feedback.block_reason
                 logging.warning(f"Summary generation blocked for {input_source_description}: {block_reason}")
                 return jsonify({"error": f"Content blocked due to: {block_reason}. Try different content."}), 400

             else:
                 # ... (handle empty summary) ...
                 logging.warning(f"Generated summary is empty for {input_source_description}.")
                 return jsonify({"summary": f"Sorry, I couldn't generate a meaningful summary for the content from {input_source_description}."}), 200


        logging.info(f"Summary generated successfully for {input_source_description}.")
        return jsonify({"summary": summary_text})

    except Exception as e:
        # (Keep the same general exception handling for the API call)
        logging.exception(f"Error during summary generation API call for {input_source_description}: {e}")
        block_reason_msg = ""
        try:
            if response and response.prompt_feedback and response.prompt_feedback.block_reason:
                 block_reason = response.prompt_feedback.block_reason
                 logging.warning(f"Summary generation potentially blocked for {input_source_description}: {block_reason}")
                 block_reason_msg = f" Content may be blocked ({block_reason})."
        except NameError: pass
        except AttributeError: pass
        return jsonify({"error": f"An internal error occurred during summary generation.{block_reason_msg} Details: {str(e)}"}), 500
# === END REVISED /generate-summary route ===

@app.route('/generate-visual-description', methods=['POST'])
def generate_visual_description():
    """Generates a text description to aid visualization."""
    logging.info("Received request for /generate-visual-description")
    if not request.is_json:
        logging.error("Request is not JSON for visual description")
        return jsonify({"error": "Request must be JSON"}), 400

    data = request.get_json()
    topic = data.get('topic')

    if not topic or not isinstance(topic, str) or not topic.strip():
        logging.error("No valid topic provided for visualization")
        return jsonify({"error": "No topic provided"}), 400

    try:
        logging.info(f"Generating visual description for topic: {topic}")
        prompt = f"""
        Generate a detailed yet easy-to-understand description (around 6-10 sentences) to help a B Tech. engineering college student visualize the concept or topic of '{topic}'.
        Focus on imagery, analogies, or easy-to-picture scenes. Avoid overly technical jargon but provide enough detail for a good mental picture.
        {'''
        Example for 'Gravity': 'Imagine the Earth like a giant, slightly stretchy trampoline. Anything with mass, like you or an apple, creates a small dip. Things naturally roll 'downhill' into these dips towards the object – that's gravity pulling them in! The bigger the mass, the deeper the dip, the stronger the pull.'
        Example for 'Photosynthesis': 'Think of a tiny solar-powered kitchen inside a plant leaf. It uses sunlight energy, water sucked up by roots, and carbon dioxide from the air to cook up sugary food (glucose) for the plant's energy. As a bonus, it releases the oxygen we breathe as a waste product. This process is vital for life on Earth.'
        '''}
        Now, generate a description for: '{topic}'
        """
        
        response = model.generate_content(prompt)

        description_text = ""
        if response.parts: description_text = response.parts[0].text
        elif hasattr(response, 'text'): description_text = response.text

        if not description_text.strip():
            if response.prompt_feedback and response.prompt_feedback.block_reason:
                block_reason = response.prompt_feedback.block_reason
                logging.warning(f"Visualization generation blocked: {block_reason}")
                return jsonify({"error": f"Content blocked due to: {block_reason}. Try a different topic."}), 400
            else:
                logging.warning("Generated visualization description is empty.")
                return jsonify({"description": "Sorry, I couldn't generate a visualization aid for this topic."}), 200

        logging.info("Visual description generated successfully.")
        return jsonify({"description": description_text})

    except Exception as e:
        logging.exception(f"Error during visual description generation API call: {e}")
        return jsonify({"error": f"An internal error occurred during visualization generation: {str(e)}"}), 500



# === MODIFY the /generate-quiz route AGAIN ===
@app.route('/generate-quiz', methods=['POST'])
@limiter.limit("5 per minute")
def generate_quiz():
    """Generates a multiple-choice quiz based on input text/topic, difficulty, and count but first checking if the input text is relevant to given subject."""
    logging.info("Received request for /generate-quiz")
    if not request.is_json:
        logging.error("Request is not JSON for quiz")
        return jsonify({"error": "Request must be JSON"}), 400

    data = request.get_json()
    source_text = data.get('text')
    # --- GET new parameters ---
    difficulty = data.get('difficulty', 'easy') # Default to easy
    subject = data.get('subject','general topics')

    try:
        # Ensure count is within reasonable bounds (e.g., 3 to 50) to prevent abuse/errors
        count = min(max(int(data.get('count', 5)), 3), 30) # Default 5, min 3, max 50
    except (ValueError, TypeError):
         logging.warning("Invalid count received, defaulting to 5.")
         count = 5
    # --- End Get ---

    if not source_text or not isinstance(source_text, str) or not source_text.strip():
        logging.error("No valid source text provided for quiz")
        return jsonify({"error": "No text or topic provided"}), 400

    # Map simple difficulty terms to descriptive phrases for the prompt
    difficulty_map = {
        "easy": "easy (suitable for secondary school level)",
        "medium": "medium difficulty (suitable for introductory university level)",
        "hard": "hard (suitable for challenging university level)"
    }
    difficulty_description = difficulty_map.get(difficulty, "easy (suitable for secondary school level)")

    try:
        logging.info(f"Generating {count} {difficulty_description} quiz questions using Gemini API...")

        # --- MODIFY Prompt ---
        prompt = f"""
        You are a strict subject-matter expert creating a quiz.

        **Step 1: Analyze Relevance.** First, determine if the following "Source Text/Topic" is relevant to the subject of **{subject.capitalize()}**.

        **Step 2: Generate Output.**
        * **If the text is NOT relevant** to {subject.capitalize()}, your ONLY output MUST be this exact JSON object:
            `{{"error": "The provided text does not seem to be related to {subject.capitalize()}. Please provide relevant text to generate a quiz."}}`
        * **If the text IS relevant**, then proceed to generate exactly {count} multiple-choice quiz questions of {difficulty_description} difficulty. For each question, provide 4 options (A, B, C, D) and the correct answer letter. Return the output ONLY as a single valid JSON list of objects, like this example: `[{{"question": "...", "options": [...], "correct_answer": "..."}}, ...]`.

        Do not add any explanatory text before or after your JSON output in either case.

        Source Text/Topic:
        ---
        {source_text}
        ---

        Generate the JSON quiz now:
        """
        # --- End Modify Prompt ---

        

        generation_config = genai.types.GenerationConfig(
            response_mime_type="application/json"
        )

        response = model.generate_content(prompt, generation_config=generation_config)
        logging.info("Quiz response received from Gemini.")

        quiz_json_string = ""
        if response.parts: quiz_json_string = response.parts[0].text
        elif hasattr(response, 'text'): quiz_json_string = response.text

        if not quiz_json_string.strip():
             # ... (keep block reason check) ...
             if response.prompt_feedback and response.prompt_feedback.block_reason:
                 block_reason = response.prompt_feedback.block_reason
                 logging.warning(f"Quiz generation blocked: {block_reason}")
                 return jsonify({"error": f"Content blocked due to: {block_reason}. Try different text."}), 400
             else:
                 logging.warning("Received empty response string for quiz JSON.")
                 return jsonify({"error": "AI returned an empty response for the quiz."}), 500

        # Validate and parse the JSON
        try:
            quiz_data = json.loads(quiz_json_string)

            # --- MODIFY Validation ---
            # Keep structural validation but REMOVE check for specific count
            if not isinstance(quiz_data, list):
                raise ValueError("Generated JSON response is not a list.")
            if not quiz_data:
                raise ValueError("Generated JSON list of questions is empty.")

            for i, q in enumerate(quiz_data):
                q_num = i + 1
                if not isinstance(q, dict): raise ValueError(f"Item {q_num} is not an object.")
                required_keys = ["question", "options", "correct_answer"]
                if not all(key in q for key in required_keys): raise ValueError(f"Q {q_num} missing keys.")
                if not isinstance(q["question"], str) or not q["question"].strip(): raise ValueError(f"Q {q_num} invalid question.")
                if not isinstance(q["options"], list) or len(q["options"]) != 4: raise ValueError(f"Q {q_num} options invalid.")
                if not all(isinstance(opt, str) and opt.strip() for opt in q["options"]): raise ValueError(f"Q {q_num} invalid option text.")
                valid_answers = ["A", "B", "C", "D"]
                correct_answer_upper = q.get("correct_answer", "").upper() # Use .get for safety
                if not correct_answer_upper or correct_answer_upper not in valid_answers: raise ValueError(f"Q {q_num} invalid correct_answer ('{q.get('correct_answer')}').")
            # --- End Modify Validation ---

            logging.info(f"Quiz JSON ({len(quiz_data)} questions) parsed and validated successfully (requested {count} {difficulty}).")
            return jsonify({"quiz": quiz_data}) # Return the potentially variable length list

        except (json.JSONDecodeError, ValueError) as e:
             # ... (keep existing JSON/Validation error handling) ...
             logging.error(f"Quiz JSON processing error: {e}\nReceived: {quiz_json_string}")
             return jsonify({"error": f"AI response was not valid quiz JSON or failed validation: {e}"}), 500
        except Exception as e:
             # ... (keep existing unexpected error handling) ...
             logging.exception(f"Unexpected error processing quiz JSON: {e}")
             return jsonify({"error": "An unexpected error occurred processing quiz data."}), 500

    except Exception as e:
        # ... (keep existing API call error handling) ...
        logging.exception(f"Error during quiz generation API call: {e}")
        block_reason_msg = ""
        # ... (code to check for block reason) ...
        return jsonify({"error": f"An internal error occurred during quiz generation.{block_reason_msg} Details: {str(e)}"}), 500
# === END MODIFIED /generate-quiz route ===


@app.route('/generate-battle-flow', methods=['POST'])
@limiter.limit("5 per minute")
def generate_battle_flow():
    """Generates a text flow of events leading up to a selected battle."""
    logging.info("Received request for /generate-battle-flow")
    if not request.is_json:
        logging.error("Request is not JSON for battle flow")
        return jsonify({"error": "Request must be JSON"}), 400

    data = request.get_json()
    battle_name = data.get('battle')

    if not battle_name or not isinstance(battle_name, str) or not battle_name.strip():
        logging.error("No valid battle name provided")
        return jsonify({"error": "No battle selected"}), 400

    try:
        logging.info(f"Generating event flow for battle: {battle_name}")
        prompt = f"""
        For the historical battle '{battle_name}', generate a concise, chronological sequence of the main events, causes, or contributing factors that led up to the battle itself.
        Present this as a clearly formatted numbered or bulleted list.
        Focus on key developments understandable by a secondary school student. Avoid excessive detail.
        Start from relevant background context and end just before the battle begins. Ensure the flow is logical and historically plausible.

        Example format for 'Battle of Hastings':
        * Death of Edward the Confessor created a succession crisis.
        * Harold Godwinson was crowned King, but faced rival claims from William of Normandy and Harald Hardrada of Norway.
        * Hardrada invaded northern England, forcing Harold to march north and defeat him at Stamford Bridge.
        * While Harold was in the north, William landed his invasion force on the south coast at Pevensey.
        * Harold rapidly marched his tired army south again to confront William near Hastings.

        Now, generate the event flow for: '{battle_name}'
        """
        response = model.generate_content(prompt)

        flow_text = ""
        if response.parts: flow_text = response.parts[0].text
        elif hasattr(response, 'text'): flow_text = response.text

        if not flow_text.strip():
            if response.prompt_feedback and response.prompt_feedback.block_reason:
                block_reason = response.prompt_feedback.block_reason
                logging.warning(f"Event flow generation blocked: {block_reason}")
                return jsonify({"error": f"Content blocked due to: {block_reason}. Try a different battle."}), 400
            else:
                logging.warning("Generated event flow is empty.")
                return jsonify({"flow": "Sorry, I couldn't generate an event flow for this battle."}), 200

        logging.info("Event flow generated successfully.")
        return jsonify({"flow": flow_text})

    except Exception as e:
        logging.exception(f"Error during battle flow generation API call: {e}")
        block_reason_msg = ""
        try:
            if response and response.prompt_feedback and response.prompt_feedback.block_reason:
                block_reason = response.prompt_feedback.block_reason
                logging.warning(f"Battle flow generation potentially blocked: {block_reason}")
                block_reason_msg = f" Content may be blocked ({block_reason})."
        except NameError: pass
        except AttributeError: pass
        return jsonify({"error": f"An internal error occurred during event flow generation.{block_reason_msg} Details: {str(e)}"}), 500


#####This is without BOX implementation
# # === MODIFY the /generate-map-info route ===
# @app.route('/generate-map-info', methods=['POST'])
# def generate_map_info():
#     """Generates structured data including bounding box for map visualization."""
#     logging.info("Received request for /generate-map-info")
#     # ... (keep existing request validation) ...
#     if not request.is_json: return jsonify({"error": "Request must be JSON"}), 400
#     data = request.get_json(); topic = data.get('topic')
#     if not topic or not topic.strip(): return jsonify({"error": "No geographical topic provided"}), 400

#     try:
#         logging.info(f"Generating map info for topic: {topic}")
#         # --- MODIFY Prompt ---
#         prompt = f"""
#         Analyze the geographical topic: "{topic}". Provide information suitable for displaying on an interactive map (like Leaflet.js) for a secondary school student.

#         Return the output ONLY as a single valid JSON object with the following keys:
#         - "center_lat": Suggested map center latitude (float). Use null if no sensible center exists.
#         - "center_lon": Suggested map center longitude (float). Use null if no sensible center exists.
#         - "zoom": Suggested initial map zoom level (integer, e.g., 3-5 for global/continental, 6-10 for country/region, 11-14 for city/area, 15+ for specific site). Use null if no sensible default zoom exists.
#         - "description": A reasonably detailed (around 4-6 sentences) geographical description of the topic, written in easy-to-understand language.
#         - "points_of_interest": A JSON list (array) of 1 to 5 specific, relevant locations. Each object must have: "name" (string), "lat" (float), "lon" (float), "popup_info" (string). Return an empty list [] if no specific points are suitable.
#         - "bounding_box": An object representing the approximate bounding box covering the main area of the topic. It should have keys: "south_west_lat" (float), "south_west_lon" (float), "north_east_lat" (float), "north_east_lon" (float). If a bounding box isn't applicable (e.g., for a single point like 'Eiffel Tower'), return null for this key. Ensure coordinates are plausible.

#         Strictly adhere to the JSON format. Output only the JSON object, nothing else.

#         Example for "Sahara Desert":
#         {{
#           "center_lat": 23.0,
#           "center_lon": 12.0,
#           "zoom": 4,
#           "description": "The Sahara is the largest hot desert in the world...",
#           "points_of_interest": [
#             {{ "name": "Erg Chebbi, Morocco", "lat": 31.16, "lon": -3.98, "popup_info": "Famous sand dunes..." }},
#             {{ "name": "Ahaggar Mountains, Algeria", "lat": 23.29, "lon": 5.54, "popup_info": "Highland region..." }}
#           ],
#           "bounding_box": {{
#              "south_west_lat": 15.0,
#              "south_west_lon": -17.0,
#              "north_east_lat": 35.0,
#              "north_east_lon": 40.0
#           }}
#         }}
#         Example for "Eiffel Tower":
#          {{
#           "center_lat": 48.8584,
#           "center_lon": 2.2945,
#           "zoom": 16,
#           "description": "A famous wrought-iron lattice tower located on the Champ de Mars in Paris, France.",
#           "points_of_interest": [
#             {{ "name": "Eiffel Tower Summit", "lat": 48.8584, "lon": 2.2945, "popup_info": "Iconic landmark offering panoramic views." }}
#           ],
#           "bounding_box": null
#         }}

#         Now generate the JSON for topic: "{topic}"
#         """
#         # --- End Modify Prompt ---

#         generation_config = genai.types.GenerationConfig(response_mime_type="application/json")
#         response = model.generate_content(prompt, generation_config=generation_config)
#         logging.info("Map info response received from Gemini.")
#         map_json_string = ""
#         # ... (keep existing logic to get map_json_string from response) ...
#         if response.parts: map_json_string = response.parts[0].text
#         elif hasattr(response, 'text'): map_json_string = response.text

#         if not map_json_string.strip():
#              # ... (keep existing block/empty response handling) ...
#               if response.prompt_feedback and response.prompt_feedback.block_reason: return jsonify({"error": f"Content blocked: {response.prompt_feedback.block_reason}"}), 400
#               else: return jsonify({"error": "AI returned an empty response for map data."}), 500


#         # --- MODIFY Validation ---
#         try:
#             map_data = json.loads(map_json_string)
#             required_keys = ["center_lat", "center_lon", "zoom", "description", "points_of_interest", "bounding_box"] # Added bounding_box
#             if not isinstance(map_data, dict) or not all(k in map_data for k in required_keys):
#                 raise ValueError(f"Generated JSON missing required keys ({required_keys}).")

#             # Validate center/zoom (allow null)
#             if map_data["center_lat"] is not None and not isinstance(map_data["center_lat"], (int, float)): raise ValueError("center_lat invalid.")
#             if map_data["center_lon"] is not None and not isinstance(map_data["center_lon"], (int, float)): raise ValueError("center_lon invalid.")
#             if map_data["zoom"] is not None and not isinstance(map_data["zoom"], int): raise ValueError("zoom invalid.")
#             if not isinstance(map_data["description"], str): raise ValueError("description invalid.")

#             # Validate points_of_interest list and items
#             if not isinstance(map_data["points_of_interest"], list): raise ValueError("points_of_interest must be a list.")
#             for i, poi in enumerate(map_data["points_of_interest"]):
#                  if not isinstance(poi, dict) or not all(k in poi for k in ["name", "lat", "lon", "popup_info"]): raise ValueError(f"POI {i+1} missing keys.")
#                  if not isinstance(poi["lat"], (int, float)) or not isinstance(poi["lon"], (int, float)): raise ValueError(f"POI {i+1} lat/lon invalid.")
#                  # Add range check
#                  if not (-90 <= poi["lat"] <= 90 and -180 <= poi["lon"] <= 180): raise ValueError(f"POI {i+1} coordinates out of bounds.")

#             # Validate bounding_box (allow null, otherwise must be object with 4 coords)
#             bbox = map_data["bounding_box"]
#             if bbox is not None:
#                  if not isinstance(bbox, dict): raise ValueError("bounding_box must be an object or null.")
#                  bbox_keys = ["south_west_lat", "south_west_lon", "north_east_lat", "north_east_lon"]
#                  if not all(k in bbox for k in bbox_keys): raise ValueError("bounding_box object missing required keys.")
#                  if not all(isinstance(bbox[k], (int, float)) for k in bbox_keys): raise ValueError("bounding_box coordinates must be numbers.")
#                  # Add basic range checks for bbox coords
#                  if not (-90 <= bbox["south_west_lat"] <= 90 and -90 <= bbox["north_east_lat"] <= 90 and \
#                          -180 <= bbox["south_west_lon"] <= 180 and -180 <= bbox["north_east_lon"] <= 180):
#                       raise ValueError("bounding_box coordinates out of bounds.")
#                  if bbox["south_west_lat"] >= bbox["north_east_lat"]: raise ValueError("bounding_box south_west_lat must be less than north_east_lat.")
#                  # Longitude check is more complex due to crossing anti-meridian, skip for simplicity

#             # --- End Modify Validation ---

#             logging.info("Map info JSON parsed and validated successfully.")
#             return jsonify(map_data)

#         except (json.JSONDecodeError, ValueError) as e:
#              # ... (keep existing JSON/Validation error handling) ...
#               logging.error(f"Map JSON processing error: {e}\nReceived: {map_json_string}")
#               return jsonify({"error": f"AI response was not valid map JSON or failed validation: {e}"}), 500
#         except Exception as e:
#              # ... (keep existing unexpected error handling) ...
#               logging.exception(f"Unexpected error processing map JSON: {e}")
#               return jsonify({"error": "An unexpected error occurred processing map data."}), 500

#     except Exception as e:
#         # ... (keep existing API call error handling) ...
#         logging.exception(f"Error during map info generation API call: {e}")
#         block_reason_msg = ""
#         # ... (code to check for block reason) ...
#         return jsonify({"error": f"An internal error occurred during map info generation.{block_reason_msg} Details: {str(e)}"}), 500
# # === END MODIFIED /generate-map-info route ===

@app.route('/generate-map-info', methods=['POST'])
def generate_map_info():
    """Generates structured data including bounding box for map visualization."""
    logging.info("Received request for /generate-map-info")
    if not request.is_json:
        logging.error("Request is not JSON for map info")
        return jsonify({"error": "Request must be JSON"}), 400

    data = request.get_json()
    topic = data.get('topic')

    if not topic or not isinstance(topic, str) or not topic.strip():
        logging.error("No valid topic provided for map")
        return jsonify({"error": "No geographical topic provided"}), 400

    try:
        logging.info(f"Generating map info for topic: {topic}")
        # Prompt requesting bounding box
        prompt = f"""
        Analyze the geographical topic: "{topic}". Provide information suitable for displaying on an interactive map (like Leaflet.js) for a secondary school student.

        Return the output ONLY as a single valid JSON object with the following keys:
        - "center_lat": Suggested map center latitude (float). Use null if no sensible center exists.
        - "center_lon": Suggested map center longitude (float). Use null if no sensible center exists.
        - "zoom": Suggested initial map zoom level (integer, e.g., 3-5 for global/continental, 6-10 for country/region, 11-14 for city/area, 15+ for specific site). Use null if no sensible default zoom exists.
        - "description": A reasonably detailed (around 4-6 sentences) geographical description of the topic, written in easy-to-understand language.
        - "points_of_interest": A JSON list (array) of 1 to 5 specific, relevant locations. Each object must have: "name" (string), "lat" (float), "lon" (float), "popup_info" (string). Return an empty list [] if no specific points are suitable.
        - "bounding_box": An object representing the approximate bounding box covering the main area of the topic. It should have keys: "south_west_lat" (float), "south_west_lon" (float), "north_east_lat" (float), "north_east_lon" (float). If a bounding box isn't applicable (e.g., for a single point like 'Eiffel Tower'), return null for this key. Ensure coordinates are plausible.

        Strictly adhere to the JSON format. Output only the JSON object, nothing else.

        Example for "Sahara Desert":
        {{
          "center_lat": 23.0,
          "center_lon": 12.0,
          "zoom": 4,
          "description": "The Sahara is the largest hot desert in the world...",
          "points_of_interest": [
            {{ "name": "Erg Chebbi, Morocco", "lat": 31.16, "lon": -3.98, "popup_info": "Famous sand dunes..." }},
            {{ "name": "Ahaggar Mountains, Algeria", "lat": 23.29, "lon": 5.54, "popup_info": "Highland region..." }}
          ],
          "bounding_box": {{
             "south_west_lat": 15.0,
             "south_west_lon": -17.0,
             "north_east_lat": 35.0,
             "north_east_lon": 40.0
          }}
        }}
        Example for "Eiffel Tower":
         {{
          "center_lat": 48.8584,
          "center_lon": 2.2945,
          "zoom": 16,
          "description": "A famous wrought-iron lattice tower located on the Champ de Mars in Paris, France.",
          "points_of_interest": [
            {{ "name": "Eiffel Tower Summit", "lat": 48.8584, "lon": 2.2945, "popup_info": "Iconic landmark offering panoramic views." }}
          ],
          "bounding_box": null
        }}

        Now generate the JSON for topic: "{topic}"
        """

        generation_config = genai.types.GenerationConfig(
            response_mime_type="application/json"
        )

        response = model.generate_content(prompt, generation_config=generation_config)
        logging.info("Map info response received from Gemini.")

        map_json_string = ""
        if response.parts: map_json_string = response.parts[0].text
        elif hasattr(response, 'text'): map_json_string = response.text

        if not map_json_string.strip():
             if response.prompt_feedback and response.prompt_feedback.block_reason:
                 block_reason = response.prompt_feedback.block_reason
                 logging.warning(f"Map info generation blocked: {block_reason}")
                 return jsonify({"error": f"Content blocked: {block_reason}. Try different text."}), 400
             else:
                 logging.warning("Received empty response string for map JSON.")
                 return jsonify({"error": "AI returned an empty response for map data."}), 500

        # --- Validate and parse the JSON ---
        try:
            map_data = json.loads(map_json_string)
            # Define required keys including the new one
            required_keys = ["center_lat", "center_lon", "zoom", "description", "points_of_interest", "bounding_box"]
            if not isinstance(map_data, dict) or not all(k in map_data for k in required_keys):
                missing = [k for k in required_keys if k not in map_data]
                raise ValueError(f"Generated JSON missing required key(s): {', '.join(missing)}.")

            # Validate types and values (allowing null for center/zoom/bbox)
            if map_data["center_lat"] is not None and not isinstance(map_data["center_lat"], (int, float)): raise ValueError("center_lat must be a number or null.")
            if map_data["center_lon"] is not None and not isinstance(map_data["center_lon"], (int, float)): raise ValueError("center_lon must be a number or null.")
            if map_data["zoom"] is not None and not isinstance(map_data["zoom"], int): raise ValueError("zoom must be an integer or null.")
            if not isinstance(map_data["description"], str): raise ValueError("description must be a string.")

            # Validate points_of_interest list
            if not isinstance(map_data["points_of_interest"], list): raise ValueError("points_of_interest must be a list.")
            for i, poi in enumerate(map_data["points_of_interest"]):
                 if not isinstance(poi, dict) or not all(k in poi for k in ["name", "lat", "lon", "popup_info"]): raise ValueError(f"POI {i+1} missing keys.")
                 if not isinstance(poi["lat"], (int, float)) or not isinstance(poi["lon"], (int, float)): raise ValueError(f"POI {i+1} lat/lon must be numbers.")
                 if not (-90 <= poi["lat"] <= 90 and -180 <= poi["lon"] <= 180): raise ValueError(f"POI {i+1} coordinates ({poi['lat']}, {poi['lon']}) out of bounds.")
                 if not isinstance(poi["name"], str) or not poi["name"].strip(): raise ValueError(f"POI {i+1} name invalid.")
                 if not isinstance(poi["popup_info"], str): raise ValueError(f"POI {i+1} popup_info invalid.") # Allow empty popup

            # Validate bounding_box (allow null, otherwise check structure and coords)
            bbox = map_data["bounding_box"]
            if bbox is not None:
                 if not isinstance(bbox, dict): raise ValueError("bounding_box must be an object or null.")
                 bbox_keys = ["south_west_lat", "south_west_lon", "north_east_lat", "north_east_lon"]
                 if not all(k in bbox for k in bbox_keys): raise ValueError(f"bounding_box object missing required key(s): {', '.join([k for k in bbox_keys if k not in bbox])}.")
                 if not all(isinstance(bbox[k], (int, float)) for k in bbox_keys): raise ValueError("bounding_box coordinates must be numbers.")
                 # Basic range and logic checks for bbox coords
                 sw_lat, sw_lon, ne_lat, ne_lon = bbox["south_west_lat"], bbox["south_west_lon"], bbox["north_east_lat"], bbox["north_east_lon"]
                 if not (-90 <= sw_lat <= 90 and -90 <= ne_lat <= 90 and -180 <= sw_lon <= 180 and -180 <= ne_lon <= 180):
                      raise ValueError("bounding_box coordinates out of valid lat/lon range.")
                 if sw_lat >= ne_lat:
                      raise ValueError("bounding_box south_west_lat must be strictly less than north_east_lat.")
                 # Note: Checking lon wrap-around (sw_lon > ne_lon) is complex and often not needed for typical map views, so omitted here.

            # --- Validation Passed ---
            logging.info("Map info JSON parsed and validated successfully.")
            # Log the data being sent back for debugging
            logging.debug(f"Returning map data: {map_data}")
            return jsonify(map_data)

        except json.JSONDecodeError as json_e:
            logging.error(f"Failed to parse map JSON response: {json_e}\nReceived text: {map_json_string}")
            return jsonify({"error": "Failed to generate valid map data format (AI response not valid JSON)."}), 500
        except ValueError as val_e:
             logging.error(f"Generated map JSON validation failed: {val_e}\nReceived JSON string: {map_json_string}")
             return jsonify({"error": f"Generated map data structure was invalid: {val_e}"}), 500
        except Exception as e:
             logging.exception(f"Unexpected error processing map JSON: {e}")
             return jsonify({"error": "An unexpected error occurred processing map data."}), 500

    except Exception as e:
        logging.exception(f"Error during map info generation API call: {e}")
        block_reason_msg = ""
        try:
            if response and response.prompt_feedback and response.prompt_feedback.block_reason:
                 block_reason = response.prompt_feedback.block_reason
                 logging.warning(f"Map info generation potentially blocked: {block_reason}")
                 block_reason_msg = f" Content may be blocked ({block_reason})."
        except NameError: pass
        except AttributeError: pass
        return jsonify({"error": f"An internal error occurred during map info generation.{block_reason_msg} Details: {str(e)}"}), 500
# === END REPLACEMENT for /generate-map-info ===



@app.route('/save-quiz-attempt', methods=['POST'])
@login_required # Only logged-in users can save attempts
def save_quiz_attempt():
    """Saves the details of a completed quiz attempt to the database."""
    logging.info(f"Received request to save quiz attempt for user: {current_user.email}")
    if not request.is_json:
        logging.error("Request is not JSON for saving quiz")
        return jsonify({"success": False, "error": "Request must be JSON"}), 400

    data = request.get_json()
    required_fields = ['originalQuiz', 'userSelections', 'score', 'totalQuestions', 'subject']

    if not all(field in data for field in required_fields):
        missing = [field for field in required_fields if field not in data]
        logging.error(f"Missing required fields in save request: {missing}")
        return jsonify({"success": False, "error": f"Missing data: {', '.join(missing)}"}), 400

    try:
        # Convert Python objects/lists to JSON strings for storage in Text fields
        quiz_data_json = json.dumps(data['originalQuiz'])
        user_answers_json = json.dumps(data['userSelections'])

        attempt = QuizAttempt(
            user_id=current_user.id,
            subject=data['subject'],
            score=int(data['score']), # Ensure integers
            total_questions=int(data['totalQuestions']),
            quiz_data=quiz_data_json,
            user_answers=user_answers_json
        )
        db.session.add(attempt)
        db.session.commit()
        logging.info(f"Quiz attempt saved successfully for user {current_user.email}, subject {data['subject']}")
        return jsonify({"success": True, "message": "Attempt saved!"})

    except json.JSONDecodeError as e:
         logging.error(f"Error encoding quiz data to JSON for saving: {e}")
         return jsonify({"success": False, "error": "Internal error processing quiz data."}), 500
    except Exception as e:
        db.session.rollback() # Rollback on error
        logging.exception(f"Error saving quiz attempt for user {current_user.email}: {e}")
        return jsonify({"success": False, "error": f"An internal error occurred: {str(e)}"}), 500




@app.route('/quiz-history')
@login_required # Must be logged in to see history
def quiz_history():
    """Displays the logged-in user's quiz attempt history."""
    logging.info(f"Fetching quiz history for user: {current_user.email}")
    try:
        # Query attempts for the current user, newest first
        attempts = QuizAttempt.query.filter_by(user_id=current_user.id)\
                                    .order_by(QuizAttempt.timestamp.desc())\
                                    .all()
        logging.info(f"Found {len(attempts)} attempts for user {current_user.email}")
        return render_template('quiz_history.html', attempts=attempts)
    except Exception as e:
         logging.exception(f"Error fetching quiz history for user {current_user.email}: {e}")
         flash('Could not retrieve quiz history due to an internal error.', 'danger')
         return redirect(url_for('index')) # Redirect home on error


# === MODIFY the /get-writing-feedback route AGAIN ===
@app.route('/get-writing-feedback', methods=['POST'])
@login_required
def get_writing_feedback():
    """Generates feedback on a user's written answer, accepting text or file upload."""
    logging.info(f"Received request for /get-writing-feedback from user: {current_user.email}")

    topic_question = ""
    user_answer = ""
    input_source_description = "unknown source"

    # --- Determine Input Type and Extract Data ---
    try:
        content_type = request.content_type
        logging.info(f"Feedback request Content-Type: {content_type}")

        if content_type.startswith('multipart/form-data'):
            logging.info("Processing feedback request as File Upload (FormData)")
            # Get topic from form data
            topic_question = request.form.get('topic_question')
            if not topic_question or not topic_question.strip():
                 raise ValueError("Missing 'topic_question' in form data.")

            # Get file from form data
            if 'answer_file' not in request.files:
                raise ValueError("No 'answer_file' part in the request")
            file = request.files['answer_file']
            if file.filename == '':
                raise ValueError("No answer file selected by the user")

            filename = file.filename
            input_source_description = f"answer file '{filename}'"
            allowed_extensions = {'txt', 'pdf'}
            if '.' not in filename or filename.rsplit('.', 1)[1].lower() not in allowed_extensions:
                raise ValueError(f"Invalid file type: {filename}. Only .txt or .pdf allowed.")

            file_extension = filename.rsplit('.', 1)[1].lower()
            logging.info(f"Processing answer file: {filename}")

            # Extract text from file (similar to summary logic)
            if file_extension == 'txt':
                try:
                    text_bytes = file.read()
                    try: user_answer = text_bytes.decode('utf-8')
                    except UnicodeDecodeError:
                         logging.warning(f"UTF-8 decode failed for {filename}, trying latin-1")
                         user_answer = text_bytes.decode('latin-1', errors='ignore')
                except Exception as e: raise IOError(f"Could not read .txt file: {e}")

            elif file_extension == 'pdf':
                try:
                    pdf_stream = io.BytesIO(file.read())
                    reader = PdfReader(pdf_stream)
                    if reader.is_encrypted:
                         try: reader.decrypt('')
                         except Exception: logging.warning(f"Could not decrypt PDF {filename}")
                    extracted_pages = [p.extract_text() or "" for p in reader.pages]
                    user_answer = "\n".join(extracted_pages)
                except Exception as e: raise IOError(f"Could not process PDF file: {e}")

        elif content_type.startswith('application/json'):
            logging.info("Processing feedback request as Text Input (JSON)")
            data = request.get_json()
            if not data: raise ValueError("Empty JSON payload received.")
            topic_question = data.get('topic_question')
            user_answer = data.get('user_answer')
            input_source_description = "typed answer"
            if not topic_question or not topic_question.strip(): raise ValueError("Missing 'topic_question' in JSON.")
            if not user_answer or not user_answer.strip(): raise ValueError("Missing 'user_answer' in JSON.")

        else:
            logging.error(f"Unsupported Content-Type for feedback: {content_type}")
            return jsonify({"error": f"Unsupported request type: {content_type}"}), 415

        # Check if we got both parts
        if not topic_question or not topic_question.strip():
             raise ValueError("Question/Topic is missing.") # Should be caught earlier ideally
        if not user_answer or not isinstance(user_answer, str) or not user_answer.strip():
            logging.warning(f"No answer content found from {input_source_description}")
            return jsonify({"error": f"Could not get any answer content from {input_source_description}."}), 400

    except (ValueError, IOError) as e:
         logging.error(f"Input Processing Error for feedback request: {e}")
         return jsonify({"error": str(e)}), 400
    except Exception as e:
        logging.exception(f"Unexpected error processing input for feedback: {e}")
        return jsonify({"error": "An unexpected error occurred processing your input."}), 500

    # --- Data Extracted/Received - Now call Gemini API ---
    try:
        logging.info(f"Generating writing feedback for topic '{topic_question[:50]}...' based on {input_source_description}")

        # Use the same detailed prompt as before
        prompt = f"""
        Act as a helpful and encouraging B Tech. College school faculty reviewing a student's written answer.
        Provide constructive feedback on the student's answer below, considering the provided question or topic.

        **Question/Topic:**
        {topic_question}

        **Student's Answer (from {input_source_description}):**
        {user_answer}

        **Instructions for Feedback:**
        1.  Acknowledge effort.
        2.  Comment on Relevance & Accuracy (mentioning AI limitations on fact-checking).
        3.  Evaluate Clarity & Structure.
        4.  Assess Completeness for secondary level.
        5.  Comment on Terminology/Vocabulary use.
        6.  Provide 1-2 specific, actionable Suggestions for Improvement.
        7.  Maintain positive, encouraging Tone. Do NOT grade.
        8.  Format clearly (e.g., use bullet points for suggestions).

        Provide the feedback now:
        """

        response = model.generate_content(prompt)

        # (Keep the same response handling logic as before)
        feedback_text = ""
        if response.parts: feedback_text = response.parts[0].text
        elif hasattr(response, 'text'): feedback_text = response.text

        if not feedback_text.strip():
             if response.prompt_feedback and response.prompt_feedback.block_reason:
                 # ... handle block reason ...
                 block_reason = response.prompt_feedback.block_reason
                 logging.warning(f"Writing feedback generation blocked: {block_reason}")
                 return jsonify({"error": f"Content blocked due to: {block_reason}. Try rephrasing."}), 400
             else:
                 # ... handle empty feedback ...
                 logging.warning("Generated writing feedback is empty.")
                 return jsonify({"feedback": "Sorry, I couldn't generate feedback for this answer."}), 200

        logging.info("Writing feedback generated successfully.")
        return jsonify({"feedback": feedback_text})

    except Exception as e:
        # (Keep the same general exception handling for the API call)
        logging.exception(f"Error during writing feedback generation API call for user {current_user.email}: {e}")
        block_reason_msg = ""
        # ... (code to check for block reason in response) ...
        return jsonify({"error": f"An internal error occurred during feedback generation.{block_reason_msg} Details: {str(e)}"}), 500
# === END REVISED /get-writing-feedback route ===



# === NEW ROUTE for Chemical Equation Balancer ===
@app.route('/balance-chemical-equation', methods=['POST'])
@login_required # Ensure user is logged in
def balance_chemical_equation():
    """Balances a chemical equation and provides an explanation."""
    logging.info(f"Received request for /balance-chemical-equation from user: {current_user.email}")
    if not request.is_json:
        logging.error("Request is not JSON for equation balancer")
        return jsonify({"error": "Request must be JSON"}), 400

    data = request.get_json()
    unbalanced_equation = data.get('equation')

    if not unbalanced_equation or not isinstance(unbalanced_equation, str) or not unbalanced_equation.strip():
        logging.error("Missing or invalid 'equation'")
        return jsonify({"error": "Please provide the unbalanced chemical equation."}), 400

    try:
        logging.info(f"Balancing chemical equation: {unbalanced_equation}")

        # Prompt for balancing and explanation, requesting JSON output
        prompt = f"""
        You are an expert chemistry assistant.
        Given the unbalanced chemical equation: "{unbalanced_equation}"

        1.  Balance this chemical equation.
        2.  Provide a step-by-step explanation of how you balanced it, or explain the principle of conservation of atoms/mass applied. If the equation is already balanced, state that and briefly explain why.
        3.  If the equation is invalid or cannot be balanced (e.g., nonsensical reactants/products), explain why.

        Return the output ONLY as a single valid JSON object with the following exact keys:
        - "balanced_equation": A string representing the balanced chemical equation. If the input was invalid or already balanced, this might reflect the input or state "Already balanced" or "Invalid equation".
        - "explanation": A string containing the detailed explanation.
        - "is_balanced_successfully": A boolean (true if successfully balanced a previously unbalanced equation, false if input was already balanced, invalid, or balancing failed).

        Example for "H2 + O2 -> H2O":
        {{
          "balanced_equation": "2H2 + O2 -> 2H2O",
          "explanation": "To balance the equation, we need an equal number of each type of atom on both sides. \n1. Oxygen: There are 2 oxygen atoms on the left (O2) and 1 on the right (H2O). Place a coefficient of 2 in front of H2O: H2 + O2 -> 2H2O. Now oxygens are balanced (2 on each side).\n2. Hydrogen: Now there are 2 hydrogen atoms on the left (H2) and 4 on the right (2H2O). Place a coefficient of 2 in front of H2: 2H2 + O2 -> 2H2O. Now hydrogens are balanced (4 on each side).\nThe equation is now balanced.",
          "is_balanced_successfully": true
        }}

        Example for "NaCl -> Na + Cl2" (already balanced if coefficients are 2, 2, 1):
        {{
          "balanced_equation": "2NaCl -> 2Na + Cl2",
          "explanation": "This equation involves the decomposition of sodium chloride. To balance it...\n1. Chlorine: 2 Cl on right, 1 on left. Add coefficient 2 to NaCl: 2NaCl -> Na + Cl2.\n2. Sodium: 2 Na on left, 1 on right. Add coefficient 2 to Na: 2NaCl -> 2Na + Cl2.\nNow all atoms are balanced.",
          "is_balanced_successfully": true
        }}

        Example for "H2O -> H2O" (already balanced):
        {{
          "balanced_equation": "H2O -> H2O",
          "explanation": "The provided equation is already balanced as the number of hydrogen and oxygen atoms are equal on both the reactant and product sides.",
          "is_balanced_successfully": false
        }}

        Now, process the equation: "{unbalanced_equation}"
        """

        generation_config = genai.types.GenerationConfig(
            response_mime_type="application/json"
        )
        response = model.generate_content(prompt, generation_config=generation_config)
        logging.info("Response received from Gemini for equation balancing.")

        equation_data_json_string = ""
        if response.parts: equation_data_json_string = response.parts[0].text
        elif hasattr(response, 'text'): equation_data_json_string = response.text

        if not equation_data_json_string.strip():
             if response.prompt_feedback and response.prompt_feedback.block_reason:
                 block_reason = response.prompt_feedback.block_reason
                 logging.warning(f"Equation balancing blocked: {block_reason}")
                 return jsonify({"error": f"Content blocked: {block_reason}. Try a different equation."}), 400
             else:
                 logging.warning("Received empty response string for equation JSON.")
                 return jsonify({"error": "AI returned an empty response for the equation."}), 500

        # Validate and parse the JSON
        try:
            equation_data = json.loads(equation_data_json_string)

            required_keys = ["balanced_equation", "explanation", "is_balanced_successfully"]
            if not isinstance(equation_data, dict) or not all(k in equation_data for k in required_keys):
                missing = [k for k in required_keys if k not in equation_data]
                raise ValueError(f"Generated JSON missing required key(s): {', '.join(missing)}.")
            if not isinstance(equation_data.get("balanced_equation"), str):
                raise ValueError("Balanced equation must be a string.")
            if not isinstance(equation_data.get("explanation"), str):
                raise ValueError("Explanation must be a string.")
            if not isinstance(equation_data.get("is_balanced_successfully"), bool):
                raise ValueError("is_balanced_successfully must be a boolean.")

            logging.info("Equation data JSON parsed and validated successfully.")
            return jsonify(equation_data) # Return the whole parsed object

        except json.JSONDecodeError as json_e:
            logging.error(f"Failed to parse equation JSON response: {json_e}\nReceived: {equation_data_json_string}")
            return jsonify({"error": "AI response was not valid JSON for the equation."}), 500
        except ValueError as val_e:
             logging.error(f"Generated equation JSON validation failed: {val_e}\nReceived: {equation_data_json_string}")
             return jsonify({"error": f"Generated equation data structure was invalid: {val_e}"}), 500

    except Exception as e:
        logging.exception(f"Error during equation balancing API call for user {current_user.email}: {e}")
        block_reason_msg = ""
        # ... (Standard block reason checking logic) ...
        try:
            if response and response.prompt_feedback and response.prompt_feedback.block_reason:
                 block_reason = response.prompt_feedback.block_reason
                 logging.warning(f"Equation balancing potentially blocked: {block_reason}")
                 block_reason_msg = f" Content may be blocked ({block_reason})."
        except NameError: pass # response not defined
        except AttributeError: pass # response has no prompt_feedback
        return jsonify({"error": f"An internal error occurred during equation processing.{block_reason_msg} Details: {str(e)}"}), 500
# === END NEW ROUTE ===      


# === NEW ROUTE for Biological Process Explainer ===
@app.route('/explain-biological-process', methods=['POST'])
@login_required # Ensure user is logged in
def explain_biological_process():
    """Explains a biological process: overview, stages, I/O, significance."""
    logging.info(f"Received request for /explain-biological-process from user: {current_user.email}")
    if not request.is_json:
        logging.error("Request is not JSON for biological process explainer")
        return jsonify({"error": "Request must be JSON"}), 400

    data = request.get_json()
    process_name = data.get('process_name')

    if not process_name or not isinstance(process_name, str) or not process_name.strip():
        logging.error("Missing or invalid 'process_name'")
        return jsonify({"error": "Please provide the name of the biological process."}), 400

    try:
        logging.info(f"Generating explanation for biological process: {process_name}")

        # Prompt for structured JSON output
        prompt = f"""
        You are an expert biology educator.
        For the biological process "{process_name}", provide a detailed explanation suitable for a secondary school or early university student.

        Return the output ONLY as a single valid JSON object with the following exact keys:
        - "process_name_explained": A string confirming the process name, perhaps slightly rephrased or with common synonyms if appropriate (e.g., "{process_name} (also known as...)").
        - "overview": A concise overview (2-4 sentences) of what the process is and its general purpose.
        - "key_stages": A list of strings, where each string describes a key stage or step in the process. If the process is very simple, this might be a short list or a single descriptive item. Aim for 3-7 key stages if applicable.
        - "inputs_outputs": A string briefly listing the main reactants/inputs and products/outputs of the process (e.g., "Inputs: Glucose, Oxygen; Outputs: ATP, Carbon Dioxide, Water").
        - "significance": A brief explanation (2-3 sentences) of the importance or significance of this process for living organisms or ecosystems.

        Ensure the language is clear, accurate, and easy to understand.

        Example for "Photosynthesis":
        {{
          "process_name_explained": "Photosynthesis",
          "overview": "Photosynthesis is the process used by plants, algae, and some bacteria to convert light energy into chemical energy, through a process that converts carbon dioxide and water into sugars (glucose) and oxygen.",
          "key_stages": [
            "Light-dependent reactions: Light energy is absorbed by chlorophyll and converted into chemical energy (ATP and NADPH). Water is split, releasing oxygen.",
            "Light-independent reactions (Calvin Cycle): ATP and NADPH from the light reactions are used to convert carbon dioxide into glucose (sugar)."
          ],
          "inputs_outputs": "Inputs: Carbon Dioxide, Water, Light Energy; Outputs: Glucose, Oxygen",
          "significance": "Photosynthesis is vital as it produces food for plants (the base of most food chains) and releases oxygen into the atmosphere, which most organisms need for respiration."
        }}

        Now, generate the JSON explanation for: "{process_name}"
        """

        generation_config = genai.types.GenerationConfig(
            response_mime_type="application/json"
        )
        response = model.generate_content(prompt, generation_config=generation_config)
        logging.info("Response received from Gemini for biological process explanation.")

        process_data_json_string = ""
        if response.parts: process_data_json_string = response.parts[0].text
        elif hasattr(response, 'text'): process_data_json_string = response.text

        if not process_data_json_string.strip():
             if response.prompt_feedback and response.prompt_feedback.block_reason:
                 block_reason = response.prompt_feedback.block_reason
                 logging.warning(f"Bio process explanation blocked: {block_reason}")
                 return jsonify({"error": f"Content blocked: {block_reason}. Try a different process."}), 400
             else:
                 logging.warning("Received empty response string for bio process JSON.")
                 return jsonify({"error": "AI returned an empty response for the process explanation."}), 500

        # Validate and parse the JSON
        try:
            process_data = json.loads(process_data_json_string)

            required_keys = ["process_name_explained", "overview", "key_stages", "inputs_outputs", "significance"]
            if not isinstance(process_data, dict) or not all(k in process_data for k in required_keys):
                missing = [k for k in required_keys if k not in process_data]
                raise ValueError(f"Generated JSON missing required key(s): {', '.join(missing)}.")

            # Further type checks
            if not isinstance(process_data.get("process_name_explained"), str): raise ValueError("'process_name_explained' must be a string.")
            if not isinstance(process_data.get("overview"), str): raise ValueError("'overview' must be a string.")
            if not isinstance(process_data.get("key_stages"), list) or not all(isinstance(s, str) for s in process_data.get("key_stages",[])):
                raise ValueError("'key_stages' must be a list of strings.")
            if not isinstance(process_data.get("inputs_outputs"), str): raise ValueError("'inputs_outputs' must be a string.")
            if not isinstance(process_data.get("significance"), str): raise ValueError("'significance' must be a string.")


            logging.info("Biological process JSON parsed and validated successfully.")
            return jsonify(process_data) # Return the whole parsed object

        except json.JSONDecodeError as json_e:
            logging.error(f"Failed to parse bio process JSON response: {json_e}\nReceived: {process_data_json_string}")
            return jsonify({"error": "AI response was not valid JSON for the process explanation."}), 500
        except ValueError as val_e:
             logging.error(f"Generated bio process JSON validation failed: {val_e}\nReceived: {process_data_json_string}")
             return jsonify({"error": f"Generated process data structure was invalid: {val_e}"}), 500

    except Exception as e:
        logging.exception(f"Error during bio process explanation API call for user {current_user.email}: {e}")
        block_reason_msg = ""
        # ... (Standard block reason checking logic) ...
        try:
            if response and response.prompt_feedback and response.prompt_feedback.block_reason:
                 block_reason = response.prompt_feedback.block_reason
                 logging.warning(f"Bio process explanation potentially blocked: {block_reason}")
                 block_reason_msg = f" Content may be blocked ({block_reason})."
        except NameError: pass
        except AttributeError: pass
        return jsonify({"error": f"An internal error occurred during process explanation.{block_reason_msg} Details: {str(e)}"}), 500
# === END NEW ROUTE ===

# === NEW ROUTE for Flashcard Generation ===
@app.route('/generate-flashcards', methods=['POST'])
@login_required # Ensure user is logged in
def generate_flashcards():
    """Generates flashcard data (term-definition pairs) from text/topic."""
    logging.info(f"Received request for /generate-flashcards from user: {current_user.email}")
    if not request.is_json:
        logging.error("Request is not JSON for flashcard generation")
        return jsonify({"error": "Request must be JSON"}), 400

    data = request.get_json()
    source_text = data.get('source_text')

    if not source_text or not isinstance(source_text, str) or not source_text.strip():
        logging.error("Missing or invalid 'source_text' for flashcards")
        return jsonify({"error": "Please provide a topic or text to generate flashcards from."}), 400

    try:
        logging.info(f"Generating flashcards for: {source_text[:70]}...") # Log truncated input

        # Prompt for generating flashcard data as JSON
        prompt = f"""
        Based on the following text or topic, identify 5 to 10 key terms, concepts, or important facts.
        For each identified item, provide a concise definition, explanation, or associated key information suitable for a flashcard.
        The "term" should be relatively short. The "definition" should be clear and informative.

        Return the output ONLY as a single valid JSON list (array) of objects. Each object must have these exact keys:
        - "term": A string representing the key term or concept (e.g., "Mitochondria", "Treaty of Versailles").
        - "definition": A string containing the concise definition or explanation for that term.

        Do not include any explanatory text, markdown, or anything else before or after the JSON list.

        Source Text/Topic:
        ---
        {source_text}
        ---

        JSON Output Example:
        [
          {{"term": "Photosynthesis", "definition": "The process by which green plants and some other organisms use sunlight to synthesize foods with the help of chlorophyll pigment."}},
          {{"term": "Chlorophyll", "definition": "A green pigment, present in all green plants and in cyanobacteria, responsible for the absorption of light to provide energy for photosynthesis."}},
          {{"term": "Stomata", "definition": "Tiny pores in the epidermis of a leaf or stem of a plant, forming a slit of variable width, which allows movement of gases in and out of the intercellular spaces."}}
        ]

        Now, generate the JSON list of flashcard data:
        """

        generation_config = genai.types.GenerationConfig(
            response_mime_type="application/json"
        )
        response = model.generate_content(prompt, generation_config=generation_config)
        logging.info("Response received from Gemini for flashcard data.")

        flashcard_json_string = ""
        if response.parts: flashcard_json_string = response.parts[0].text
        elif hasattr(response, 'text'): flashcard_json_string = response.text

        if not flashcard_json_string.strip():
             if response.prompt_feedback and response.prompt_feedback.block_reason:
                 block_reason = response.prompt_feedback.block_reason
                 logging.warning(f"Flashcard generation blocked: {block_reason}")
                 return jsonify({"error": f"Content blocked: {block_reason}. Try different text."}), 400
             else:
                 logging.warning("Received empty response string for flashcard JSON.")
                 return jsonify({"error": "AI returned an empty response for flashcards."}), 500

        # Validate and parse the JSON
        try:
            flashcard_data = json.loads(flashcard_json_string)

            required_keys = ["term", "definition"]
            if not isinstance(flashcard_data, list):
                raise ValueError("Generated JSON response is not a list.")
            # Allow empty list if AI genuinely finds no terms
            # if not flashcard_data:
            #     raise ValueError("Generated JSON list of flashcards is empty.")

            for i, card in enumerate(flashcard_data):
                item_num = i + 1
                if not isinstance(card, dict):
                    raise ValueError(f"Flashcard item {item_num} in JSON list is not an object.")
                if not all(key in card for key in required_keys):
                    missing = [key for key in required_keys if key not in card]
                    raise ValueError(f"Flashcard item {item_num} is missing required key(s): {', '.join(missing)}.")
                if not isinstance(card.get("term"), str) or not card.get("term","").strip():
                     raise ValueError(f"Flashcard item {item_num} has invalid or empty 'term'.")
                if not isinstance(card.get("definition"), str) or not card.get("definition","").strip():
                     raise ValueError(f"Flashcard item {item_num} has invalid or empty 'definition'.")

            logging.info(f"Flashcard data JSON ({len(flashcard_data)} cards) parsed and validated successfully.")
            return jsonify({"flashcards": flashcard_data}) # Return the list

        except json.JSONDecodeError as json_e:
            logging.error(f"Failed to parse flashcard JSON response: {json_e}\nReceived: {flashcard_json_string}")
            return jsonify({"error": "AI response was not valid JSON for flashcards."}), 500
        except ValueError as val_e:
             logging.error(f"Generated flashcard JSON validation failed: {val_e}\nReceived: {flashcard_json_string}")
             return jsonify({"error": f"Generated flashcard data structure was invalid: {val_e}"}), 500

    except Exception as e:
        logging.exception(f"Error during flashcard generation API call for user {current_user.email}: {e}")
        block_reason_msg = ""
        # ... (Standard block reason checking logic) ...
        try:
            if response and response.prompt_feedback and response.prompt_feedback.block_reason:
                 block_reason = response.prompt_feedback.block_reason
                 logging.warning(f"Flashcard generation potentially blocked: {block_reason}")
                 block_reason_msg = f" Content may be blocked ({block_reason})."
        except NameError: pass
        except AttributeError: pass
        return jsonify({"error": f"An internal error occurred during flashcard generation.{block_reason_msg} Details: {str(e)}"}), 500
# === END NEW ROUTE ===

# === NEW ROUTE for Chatbot Messages ===
@app.route('/chatbot-message', methods=['POST'])
@login_required # Optional: require login to use chatbot, or remove for public access
def chatbot_message():
    """Handles messages sent to the AI chatbot and returns a response."""
    logging.info(f"Received request for /chatbot-message from user: {current_user.email if current_user.is_authenticated else 'Guest'}")
    if not request.is_json:
        logging.error("Request is not JSON for chatbot")
        return jsonify({"error": "Request must be JSON"}), 400

    data = request.get_json()
    user_message = data.get('message')

    if not user_message or not isinstance(user_message, str) or not user_message.strip():
        logging.error("Missing or invalid 'message' for chatbot")
        return jsonify({"reply": "Sorry, I didn't understand that. Please type a message."}), 400 # Send a reply even for empty

    try:
        logging.info(f"User message to chatbot: {user_message}")

        # Attempt to get current subject from session or a hidden field if needed for context
        # For now, a general prompt.
        # You could enhance this by passing subject context if the chatbot is on a subject page.
        # current_subject = session.get('current_subject_for_chatbot', 'general topics')

        # General conversational prompt
        # For a more robust chatbot, you'd manage conversation history.
        # This is a stateless (single-turn) version for simplicity.
        prompt = f"""
        You are a friendly and helpful AI assistant for a student learning platform.
        The student said: "{user_message}"

        Respond concisely and helpfully but do not answer anything out of scope of physics,chemistry,biology,history and geography. If the question is complex or outside your general knowledge of above mentioned subjects,
        politely state that you can help with general queries or guide them to specific features on the platform.
        Keep your answers relatively short and suitable for a chat interface.
        If asked about a specific subject and you know that the topic is of above mentioned subjects,
        try to tailor your answer slightly if appropriate, but primarily act as a general helper and at end mention that for detailed queries,please go to that subject specific page on our platform depending on topic. If question is out of scope of above mentioned subjects, say that right now the platform focusses only on above mentioned subject(mention science and social science) and we will get back with other subjects soon.
        Do not make up facts. If you don't know, say so.
        If any asks you that who developed you,say You have been developed by Atul and Vardhan under guidance of Prapulla Ma'am.
        """

        # If you want to maintain conversation history (more advanced):
        # chat_session = model.start_chat(history=[...previous messages...])
        # response = chat_session.send_message(prompt)

        # For stateless:
        response = model.generate_content(prompt)

        ai_reply = ""
        if response.parts: ai_reply = response.parts[0].text
        elif hasattr(response, 'text'): ai_reply = response.text

        if not ai_reply.strip():
             if response.prompt_feedback and response.prompt_feedback.block_reason:
                 block_reason = response.prompt_feedback.block_reason
                 logging.warning(f"Chatbot reply generation blocked: {block_reason}")
                 ai_reply = f"Sorry, I can't respond to that due to content restrictions ({block_reason})."
             else:
                 logging.warning("Chatbot AI reply is empty.")
                 ai_reply = "I'm not sure how to respond to that right now. Can you try asking differently?"

        logging.info(f"AI chatbot reply: {ai_reply[:100]}...") # Log truncated reply
        return jsonify({"reply": ai_reply})

    except Exception as e:
        logging.exception(f"Error during chatbot message processing: {e}")
        return jsonify({"reply": "Sorry, I encountered an error and can't respond right now."}), 500
# === END NEW ROUTE ===



# Generic route for all simulations
@app.route("/simulation/<sim_name>")
def load_simulation(sim_name):
    allowed_pages = {
        "torsional-pendulum": "torsional_pendulum.html",
        "spring-constant": "spring_constant.html",
        "laser-diffraction": "laser_diffraction.html",
        "hall-effect": "hall_effect.html",
        "copper-brass": "copperinbrass.html"
    }

    if sim_name in allowed_pages:
        return render_template(allowed_pages[sim_name])
    else:
        return "Simulation not found", 404


# === Process Uploaded PDF for Q&A Route ===
@app.route('/process-pdf-for-qa', methods=['POST'])
@login_required
def process_pdf_for_qa():
    # ... (This route's logic remains largely the same, as it calls create_and_save_vector_store) ...
    # Ensure it's complete as per Phase 21, Step 2 from previous instructions.
    # The key change is that create_and_save_vector_store now handles the API key for embeddings.
    logging.info(f"Attempting to process PDF for Q&A. User: {current_user.email}")
    if 'pdf_file' not in request.files:
        logging.error("[PDF_QA_PROCESS] No 'pdf_file' in request.files")
        return jsonify({"success": False, "error": "No PDF file provided in the request."}), 400
    pdf_file = request.files['pdf_file']
    if pdf_file.filename == '':
        logging.error("[PDF_QA_PROCESS] No PDF file selected (empty filename).")
        return jsonify({"success": False, "error": "No PDF file selected."}), 400
    if '.' not in pdf_file.filename or pdf_file.filename.rsplit('.', 1)[1].lower() != 'pdf':
        logging.error(f"[PDF_QA_PROCESS] Invalid file type: {pdf_file.filename}")
        return jsonify({"success": False, "error": "Invalid file type. Please upload a PDF."}), 400
    try:
        file_content_for_hash = pdf_file.read(); pdf_file.seek(0)
        m = hashlib.md5(); m.update(file_content_for_hash[:4096]); m.update(str(current_user.id).encode()); pdf_file_id = m.hexdigest()
        user_index_dir = os.path.join(FAISS_INDEX_DIR, str(current_user.id)); os.makedirs(user_index_dir, exist_ok=True)
        index_path = os.path.join(user_index_dir, pdf_file_id)
        logging.info(f"[PDF_QA_PROCESS] Preparing to process PDF: {pdf_file.filename}. Index: {index_path}")
        raw_text = get_pdf_text_from_file_storage(pdf_file)
        if not raw_text or not raw_text.strip():
            logging.error(f"[PDF_QA_PROCESS] No text extracted from PDF: {pdf_file.filename}")
            return jsonify({"success": False, "error": "Could not extract text from the PDF."}), 400
        text_chunks = get_text_chunks_langchain(raw_text)
        if not text_chunks:
            logging.error(f"[PDF_QA_PROCESS] Could not split PDF text into chunks: {pdf_file.filename}")
            return jsonify({"success": False, "error": "Could not split PDF text into chunks."}), 400
        create_and_save_vector_store(text_chunks, index_path) # This now uses API_KEY internally
        session['current_pdf_qa_index_path'] = index_path
        session['current_pdf_filename'] = pdf_file.filename
        logging.info(f"[PDF_QA_PROCESS] PDF '{pdf_file.filename}' processed. Index: {index_path}")
        return jsonify({"success": True, "message": f"PDF '{pdf_file.filename}' processed.", "pdf_filename": pdf_file.filename})
    except Exception as e:
        logging.exception(f"[PDF_QA_PROCESS] Error processing PDF (User: {current_user.email}, File: {pdf_file.filename if 'pdf_file' in locals() and pdf_file else 'N/A'}): {e}")
        return jsonify({"success": False, "error": f"An error occurred processing the PDF: {str(e)}"}), 500


# === Ask Questions about the Processed PDF Route (MODIFIED) ===
@app.route('/ask-pdf-question', methods=['POST'])
@login_required
def ask_pdf_question():
    logging.info(f"Attempting to answer PDF question. User: {current_user.email}")
    if not request.is_json: return jsonify({"error": "Request must be JSON"}), 400
    data = request.get_json(); user_question = data.get('question')
    index_path = session.get('current_pdf_qa_index_path')

    if not index_path or not os.path.exists(index_path):
        logging.error("[PDF_QA_ASK] No active PDF index found or path invalid.")
        return jsonify({"reply": "No PDF processed or session expired. Please upload PDF first."}), 400
    if not user_question or not user_question.strip(): return jsonify({"reply": "Please ask a question."}), 400

    try:
        # vvvvv MODIFICATION: Explicitly pass api_key vvvvv
        embeddings = GoogleGenerativeAIEmbeddings(
            model="models/embedding-001",
            google_api_key=API_KEY # Use the API_KEY loaded from .env
        )
        # ^^^^^ END MODIFICATION ^^^^^
        vector_store = FAISS.load_local(index_path, embeddings, allow_dangerous_deserialization=True)
        logging.info(f"[PDF_QA_ASK] FAISS index loaded from {index_path} for question: {user_question[:50]}...")

        relevant_docs = vector_store.similarity_search(user_question, k=3)
        if not relevant_docs:
            logging.warning(f"[PDF_QA_ASK] No relevant documents found for: {user_question[:50]}...")
            return jsonify({"reply": "I couldn't find relevant information in the document to answer that."})

        logging.info(f"[PDF_QA_ASK] Found {len(relevant_docs)} relevant chunks.")
        chain = get_conversational_qa_chain() # This now uses API_KEY internally for its LLM
        response = chain({"input_documents": relevant_docs, "question": user_question}, return_only_outputs=True)

        ai_reply = response.get("output_text", "Sorry, I encountered an issue generating a response.")
        logging.info(f"[PDF_QA_ASK] AI reply: {ai_reply[:100]}...")
        return jsonify({"reply": ai_reply})
    except Exception as e:
        logging.exception(f"[PDF_QA_ASK] Error answering PDF question (User: {current_user.email}): {e}")
        # Check if the error is related to authentication specifically
        if "API key not valid" in str(e) or "permission" in str(e).lower():
            return jsonify({"reply": f"Error authenticating with AI service: {str(e)}. Please check server configuration."}), 500
        return jsonify({"reply": f"An error occurred answering: {str(e)}"}), 500


# Create database tables if they don't exist
with app.app_context():
    try:
        db.create_all()
        logging.info("Database tables checked/created.")
    except Exception as e:
        logging.error(f"Error creating database tables: {e}")

# --- Run the App ---
if __name__ == '__main__':
    # Set debug=True for development (auto-reloads, detailed errors)
    # Set debug=False for production
    # host='0.0.0.0' makes it accessible on your local network
    #app.run(debug=True, host='0.0.0.0', port=5000)
    app.run(debug=False)