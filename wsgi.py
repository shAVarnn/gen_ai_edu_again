import sys
import os

# Add the project directory to the sys.path
# This allows the server to find your 'app' module
path = os.path.dirname(os.path.abspath(__file__))
if path not in sys.path:
    sys.path.insert(0, path)

# Import the Flask app instance from your main application file
from app import app as application