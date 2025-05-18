// We will wrap all code in DOMContentLoaded to ensure HTML is loaded first
document.addEventListener("DOMContentLoaded", () => {
  console.log("DOM Loaded - main.js executing.");

  // === START GLOBAL HELPER FUNCTIONS (accessible by multiple features) ===

  /**
   * Displays a result in a specified div and shows its associated TTS button.
   * @param {string} resultDivId - The ID of the div to display the result in.
   * @param {string} ttsButtonQuerySelector - The query selector for the TTS button.
   */
  function showResultAndButton(resultDivId) {
    const resultDiv = document.getElementById(resultDivId);
    // Construct the TTS button selector based on the resultDivId if a pattern is used
    const ttsButton = document.querySelector(
      `.read-aloud-button[data-target="${resultDivId}"]`
    );

    if (resultDiv) {
      // Ensure content is actually present before showing
      const content =
        resultDiv.innerHTML.trim() || resultDiv.textContent.trim();
      if (
        content.length > 0 &&
        content !== "<p></p>" &&
        content !== "<p>No explanation provided.</p>" &&
        content !== "No explanation provided."
      ) {
        // Check for meaningful content
        resultDiv.style.display = "block";
        if (ttsButton) {
          ttsButton.style.display = "inline-block";
        }
      } else {
        resultDiv.style.display = "none"; // Hide if no meaningful content
        if (ttsButton) {
          ttsButton.style.display = "none";
        }
      }
    } else {
      console.warn(
        `showResultAndButton: Result div with ID '${resultDivId}' not found.`
      );
    }
  }

  /**
   * Formats text that might contain markdown-like lists (bulleted or numbered) into HTML.
   * @param {string} text - The input text.
   * @returns {string} - HTML string with lists formatted.
   */
  function formatTextWithLists(text) {
    if (!text || typeof text !== "string") return "<p>No content provided.</p>"; // Return a default paragraph
    const lines = text.split("\n");
    let htmlContent = "";
    let listType = null; // 'ul' or 'ol'

    lines.forEach((line) => {
      const trimmedLine = line.trim();
      let currentItemType = null;
      let itemText = "";

      if (trimmedLine.startsWith("* ") || trimmedLine.startsWith("- ")) {
        currentItemType = "ul";
        itemText = trimmedLine.substring(2);
      } else if (trimmedLine.match(/^\d+\.\s/)) {
        // Matches "1. ", "2. ", etc.
        currentItemType = "ol";
        itemText = trimmedLine.replace(/^\d+\.\s/, "");
      }

      if (currentItemType) {
        if (listType !== currentItemType) {
          // New list or changed type
          if (listType) htmlContent += `</${listType}>`; // Close previous list
          listType = currentItemType;
          htmlContent += `<${listType}>`;
        }
        const li = document.createElement("li");
        li.textContent = itemText; // Safely set text content
        htmlContent += li.outerHTML;
      } else {
        // Not a list item
        if (listType) {
          // If a list was open, close it
          htmlContent += `</${listType}>`;
          listType = null;
        }
        if (trimmedLine.length > 0) {
          // Add non-empty lines as paragraphs
          const p = document.createElement("p");
          p.textContent = trimmedLine; // Safely set text content
          htmlContent += p.outerHTML;
        }
      }
    });
    if (listType) {
      htmlContent += `</${listType}>`;
    } // Close any open list at the end

    return htmlContent.trim() ? htmlContent : `<p>${text}</p>`; // Fallback if no formatting applied
  }

  // === END GLOBAL HELPER FUNCTIONS ===

  // === Summarization Feature Block (Attach Button UI) ===
  const summarizeButton = document.getElementById("summarize-button");
  const textToSummarizeInput = document.getElementById("text-to-summarize");
  const hiddenFileInput = document.getElementById("file-to-summarize-hidden");
  const uploadButton = document.getElementById("upload-summary-button"); // The visible attach button
  const selectedFileInfoSpan = document.getElementById("selected-summary-file");
  const summaryResultDiv = document.getElementById("summary-result");
  const summaryLoadingDiv = document.getElementById("summary-loading");
  const summaryTtsButton = document.querySelector(
    '.read-aloud-button[data-target="summary-result"]'
  );

  let selectedSummaryFile = null; // Variable to store the selected file object

  // Check if all necessary elements exist
  if (
    summarizeButton &&
    textToSummarizeInput &&
    hiddenFileInput &&
    uploadButton &&
    selectedFileInfoSpan &&
    summaryResultDiv &&
    summaryLoadingDiv
  ) {
    console.log("Summary (Attach Button UI) elements found.");

    // --- Event Listener for the VISIBLE Upload/Attach Button ---
    uploadButton.addEventListener("click", () => {
      hiddenFileInput.click(); // Trigger the hidden file input dialog
    });

    // --- Event Listener for the HIDDEN File Input (when a file is selected) ---
    hiddenFileInput.addEventListener("change", (event) => {
      if (event.target.files && event.target.files.length > 0) {
        selectedSummaryFile = event.target.files[0]; // Store the file object
        console.log("File selected:", selectedSummaryFile.name);
        displaySelectedFileName(selectedSummaryFile.name);
        // Optional: Clear textarea when file is selected? Maybe not necessary.
        // textToSummarizeInput.value = '';
      } else {
        // This might trigger if the user cancels the dialog
        selectedSummaryFile = null;
        displaySelectedFileName(null); // Clear displayed name
      }
    });

    // --- Event Listener for the main "Generate Summary" Button ---
    summarizeButton.addEventListener("click", async () => {
      console.log("Summarize button clicked.");

      let fetchOptions = { method: "POST" };
      let isValid = false;
      let inputDescription = ""; // For loading text

      // --- Check if a file is selected ---
      if (selectedSummaryFile) {
        console.log("Processing selected file:", selectedSummaryFile.name);
        // Optional: Add client-side validation again if needed
        const fileName = selectedSummaryFile.name.toLowerCase();
        if (!fileName.endsWith(".txt") && !fileName.endsWith(".pdf")) {
          displaySummaryError(
            `Invalid file type selected (${selectedSummaryFile.name}). Please attach .txt or .pdf.`
          );
          clearSelectedFile(); // Clear the invalid selection
          return;
        }

        const formData = new FormData();
        formData.append("file", selectedSummaryFile);
        // Backend checks content-type, no need to send 'input_type' explicitly with FormData
        fetchOptions.body = formData;
        isValid = true;
        inputDescription = "Processing file and generating summary...";
      } else {
        // --- No file selected, use textarea content ---
        const text = textToSummarizeInput.value.trim();
        if (!text) {
          displaySummaryError(
            "Please paste some text OR attach a file to summarize."
          );
          return;
        }
        console.log("Processing text from textarea.");
        fetchOptions.headers = { "Content-Type": "application/json" };
        fetchOptions.body = JSON.stringify({ text: text }); // Send only text for JSON request
        isValid = true;
        inputDescription = "Generating summary from text...";
      }

      if (!isValid) {
        // Should not happen with this logic, but good to have a check
        console.error("No valid input method determined.");
        return;
      }

      // --- Reset UI & Fetch ---
      summaryLoadingDiv.textContent = inputDescription; // Set specific loading text
      summaryLoadingDiv.style.display = "block";
      summaryResultDiv.style.display = "none";
      summaryResultDiv.className = "result-box";
      summaryResultDiv.innerHTML = "";
      if (summaryTtsButton) summaryTtsButton.style.display = "none";

      try {
        console.log("Sending request to /generate-summary...");
        const response = await fetch("/generate-summary", fetchOptions); // Use prepared options

        summaryLoadingDiv.style.display = "none";
        const data = await response.json(); // Expect JSON response always

        if (!response.ok) {
          const errorMsg =
            data.error ||
            `HTTP error! status: ${response.status} ${response.statusText}`;
          console.error("Summary generation failed:", errorMsg);
          displaySummaryError(errorMsg);
        } else {
          console.log("Summary received:", data.summary);
          displaySummaryResult(data.summary); // Display result
        }
      } catch (error) {
        console.error("Error during summary fetch operation:", error);
        summaryLoadingDiv.style.display = "none";
        displaySummaryError(
          "A network or unexpected error occurred. Please check the console."
        );
      } finally {
        // Clear file selection after attempt
        clearSelectedFile();
      }
    }); // End summarizeButton listener

    // --- Helper Function to Display Selected File Name ---
    function displaySelectedFileName(filename) {
      if (filename) {
        selectedFileInfoSpan.innerHTML = ""; // Clear previous
        const textNode = document.createTextNode(filename + " "); // Add space before button
        selectedFileInfoSpan.appendChild(textNode);

        // Add a small button to clear the file selection
        const clearButton = document.createElement("button");
        clearButton.textContent = "✖"; // 'X' symbol
        clearButton.classList.add("clear-file-button");
        clearButton.title = "Clear selected file";
        clearButton.type = "button"; // Prevent form submission if nested
        clearButton.addEventListener("click", clearSelectedFile);
        selectedFileInfoSpan.appendChild(clearButton);

        selectedFileInfoSpan.style.display = "inline-flex"; // Show the span
      } else {
        selectedFileInfoSpan.innerHTML = ""; // Clear content
        selectedFileInfoSpan.style.display = "none"; // Hide the span
      }
    }

    // --- Helper Function to Clear File Selection ---
    function clearSelectedFile() {
      selectedSummaryFile = null;
      hiddenFileInput.value = ""; // Clear the hidden input's value
      displaySelectedFileName(null); // Update UI
      console.log("Cleared file selection.");
    }
  } else {
    console.log(
      "Summary (Attach Button UI) elements not fully found on this page."
    );
  }

  // Keep existing displaySummaryResult and displaySummaryError functions
  // Ensure they handle the TTS button correctly as added in Phase 8
  // function displaySummaryResult(summary) { ... call showResultAndButton('summary-result'); ... }
  // function displaySummaryError(errorMessage) { ... hide TTS button ... }

  // === END REVISED Summarization Feature Block ===

  function displaySummaryResult(summary) {
    summaryResultDiv.textContent = summary; // Use textContent for safety against XSS
    summaryResultDiv.className = "result-box success";
    summaryResultDiv.style.display = "block";
  }

  function displaySummaryError(errorMessage) {
    summaryResultDiv.textContent = `Error: ${errorMessage}`;
    summaryResultDiv.className = "result-box error";
    summaryResultDiv.style.display = "block";
  }

  // --- Feature: Visualization Aid ---
  const visualizeButton = document.getElementById("visualize-button");
  const topicToVisualize = document.getElementById("topic-to-visualize");
  const visualizeResultDiv = document.getElementById("visualize-result");
  const visualizeLoadingDiv = document.getElementById("visualize-loading");

  if (
    visualizeButton &&
    topicToVisualize &&
    visualizeResultDiv &&
    visualizeLoadingDiv
  ) {
    console.log("Visualization elements found.");
    visualizeButton.addEventListener("click", async () => {
      console.log("Visualize button clicked.");
      const topic = topicToVisualize.value.trim();

      if (!topic) {
        displayVisualizeError("Please enter a topic to visualize.");
        return;
      }

      // Reset UI
      visualizeLoadingDiv.style.display = "block";
      visualizeResultDiv.style.display = "none";
      visualizeResultDiv.className = "result-box";
      visualizeResultDiv.innerHTML = "";

      try {
        console.log("Sending topic for visualization description...");
        const response = await fetch("/generate-visual-description", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ topic: topic }),
        });

        visualizeLoadingDiv.style.display = "none";
        const data = await response.json();

        if (!response.ok) {
          const errorMsg =
            data.error ||
            `HTTP error! status: ${response.status} ${response.statusText}`;
          console.error("Visualization generation failed:", errorMsg);
          displayVisualizeError(errorMsg);
        } else {
          console.log("Visualization description received:", data.description);
          displayVisualizeResult(data.description);
        }
      } catch (error) {
        console.error("Error during visualization fetch operation:", error);
        visualizeLoadingDiv.style.display = "none";
        displayVisualizeError(
          "An network or unexpected error occurred. Please check the console."
        );
      }
    });
  } else {
    console.log("Visualization elements not found on this page.");
  }

  function displayVisualizeResult(description) {
    visualizeResultDiv.textContent = description; // Use textContent
    visualizeResultDiv.className = "result-box success";
    visualizeResultDiv.style.display = "block";
  }

  function displayVisualizeError(errorMessage) {
    visualizeResultDiv.textContent = `Error: ${errorMessage}`;
    visualizeResultDiv.className = "result-box error";
    visualizeResultDiv.style.display = "block";
  }

  // === Quiz Generation Feature Block ===
  console.log("Setting up Quiz feature...");

  const generateQuizButton = document.getElementById("generate-quiz-button");
  const quizSourceText = document.getElementById("quiz-source-text");
  const quizLoadingDiv = document.getElementById("quiz-loading");
  const quizAreaDiv = document.getElementById("quiz-area");
  const quizQuestionsDiv = document.getElementById("quiz-questions");
  const showAnswersButton = document.getElementById("show-answers-button");
  const quizAnswersDiv = document.getElementById("quiz-answers");
  const quizErrorDiv = document.getElementById("quiz-error");
  // --- ADD selectors for new inputs ---
  const quizDifficultySelect = document.getElementById("quiz-difficulty");
  const quizQuestionCountInput = document.getElementById("quiz-question-count");
  // --- End Add ---
  let submitQuizButton = null;
  let currentQuizData = null;

  // Check if essential elements exist
  if (
    generateQuizButton &&
    quizSourceText &&
    quizLoadingDiv &&
    quizAreaDiv &&
    quizQuestionsDiv &&
    quizErrorDiv &&
    quizDifficultySelect &&
    quizQuestionCountInput
  ) {
    // Add new inputs to check
    console.log(
      "Quiz GENERATION elements found. Attaching listener to Generate button."
    );

    // --- Event Listener for the "Generate Quiz" Button ---
    generateQuizButton.addEventListener("click", async () => {
      console.log("Generate Quiz button click event fired!");
      const sourceText = quizSourceText.value.trim();
      // --- GET values from new inputs ---
      const difficulty = quizDifficultySelect.value;
      const count = parseInt(quizQuestionCountInput.value, 10); // Get integer value
      // --- End Get ---

      // Validate inputs
      if (!sourceText) {
        if (typeof displayQuizError === "function")
          displayQuizError("Please enter a topic or paste some text.");
        return;
      }
      if (isNaN(count) || count < 3 || count > 100) {
        // Adjust max if needed, but warn about large numbers
        if (typeof displayQuizError === "function")
          displayQuizError(
            "Please enter a valid number of questions (e.g., 3-20). Requesting very large numbers may take time or fail."
          );
        return;
      }
      if (!difficulty) {
        // Should have a default
        if (typeof displayQuizError === "function")
          displayQuizError("Please select a difficulty level.");
        return;
      }

      // Reset UI
      quizLoadingDiv.style.display = "block";
      quizAreaDiv.style.display = "none";
      quizQuestionsDiv.innerHTML = "";
      if (quizAnswersDiv) quizAnswersDiv.style.display = "none";
      if (showAnswersButton) showAnswersButton.style.display = "none";
      quizErrorDiv.style.display = "none";
      currentQuizData = null;
      document.getElementById("submit-quiz-button")?.remove();
      document.getElementById("quiz-score-display")?.remove();

      try {
        console.log(
          `Sending text for ${count} ${difficulty} quiz questions...`
        );
        // --- SEND new parameters to backend ---
        const response = await fetch("/generate-quiz", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            text: sourceText,
            difficulty: difficulty, // Add difficulty
            count: count, // Add count
          }),
        });
        // --- End Send ---

        quizLoadingDiv.style.display = "none";

        if (!response.ok) {
          // ... (keep existing error handling logic) ...
          let errorMsg = `HTTP error! status: ${response.status} ${response.statusText}`;
          try {
            const errorData = await response.json();
            errorMsg = errorData.error || errorMsg;
          } catch (e) {
            console.warn("Could not parse JSON from error response:", e);
          }
          console.error("Quiz generation failed:", errorMsg);
          if (typeof displayQuizError === "function")
            displayQuizError(errorMsg);
        } else {
          const data = await response.json();
          // Validate response data
          if (data.quiz && Array.isArray(data.quiz) && data.quiz.length > 0) {
            console.log(
              `Quiz data received (${data.quiz.length} questions):`,
              data.quiz
            );
            // Warn if count doesn't match request, but proceed
            if (data.quiz.length !== count) {
              console.warn(
                `Requested ${count} questions, but received ${data.quiz.length}.`
              );
            }
            currentQuizData = data.quiz;
            if (typeof displayInteractiveQuiz === "function")
              displayInteractiveQuiz(currentQuizData);
            quizAreaDiv.style.display = "block";
          } else {
            console.error(
              "Received success response but no valid quiz data structure:",
              data
            );
            if (typeof displayQuizError === "function")
              displayQuizError(
                "Failed to generate a valid quiz. The AI response might be empty or malformed."
              );
          }
        } // End else (response.ok)
      } catch (error) {
        // Catch fetch/network errors
        // ... (keep existing catch block logic) ...
        console.error("Error during quiz fetch operation:", error);
        quizLoadingDiv.style.display = "none";
        if (typeof displayQuizError === "function")
          displayQuizError(
            "A network or unexpected error occurred. Please check the console."
          );
      } // End try/catch
    }); // End generateQuizButton event listener

    // --- Event Listener for the original "Show Answers" button (Optional Fallback) ---
    if (showAnswersButton) {
      console.log("Show Answers button found. Attaching listener.");
      showAnswersButton.addEventListener("click", () => {
        console.log("Show Answers button clicked.");
        if (currentQuizData) {
          // Ensure helper function exists
          if (typeof displayQuizAnswers === "function")
            displayQuizAnswers(currentQuizData);
          else console.error("displayQuizAnswers function not found.");

          if (quizAnswersDiv) quizAnswersDiv.style.display = "block"; // Show the answers div
          showAnswersButton.style.display = "none"; // Hide this button

          // Also hide the Submit button if it exists
          document.getElementById("submit-quiz-button")?.remove();
          // Also hide score display if it exists
          document.getElementById("quiz-score-display")?.remove();
        } else {
          console.warn("Show Answers clicked, but no quiz data available.");
        }
      });
    } else {
      console.log(
        "Show Answers button NOT found (this is okay if using interactive quiz primarily)."
      );
    }
  } else {
    // Log which essential elements were missing if the initial check failed
    console.error(
      "Required Quiz elements for GENERATION were NOT found. Check IDs in HTML and JS."
    );
    if (!quizDifficultySelect) console.error("quiz-difficulty missing");
    if (!quizQuestionCountInput) console.error("quiz-question-count missing");
    if (!generateQuizButton) console.error("generate-quiz-button missing");
    if (!quizSourceText) console.error("quiz-source-text missing");
    if (!quizLoadingDiv) console.error("quiz-loading missing");
    if (!quizAreaDiv) console.error("quiz-area missing");
    if (!quizQuestionsDiv) console.error("quiz-questions missing");
    if (!quizErrorDiv) console.error("quiz-error missing");
  }

  // --- Helper Function to display the interactive quiz ---
  function displayInteractiveQuiz(quizData) {
    if (!quizQuestionsDiv || !quizAreaDiv || !quizErrorDiv) {
      console.error("Cannot display quiz, essential display elements missing.");
      return;
    }
    quizQuestionsDiv.innerHTML = ""; // Clear previous questions
    quizData.forEach((q, index) => {
      const questionElement = document.createElement("div");
      questionElement.classList.add("quiz-question-item", "interactive");
      questionElement.setAttribute("data-question-index", index);

      const safeQuestion = document.createElement("p");
      safeQuestion.innerHTML = `<strong>${index + 1}. </strong>`;
      safeQuestion.appendChild(
        document.createTextNode(q.question || "[Missing Question]")
      );
      questionElement.appendChild(safeQuestion);

      const optionsList = document.createElement("div");
      optionsList.classList.add("quiz-options-interactive");
      (q.options || []).forEach((option, i) => {
        const optionId = `q${index}-opt${i}`;
        const optionValue = String.fromCharCode(65 + i); // A, B, C, D
        const optionLabel = document.createElement("label");
        optionLabel.classList.add("quiz-option-label");
        optionLabel.setAttribute("for", optionId);
        const radioButton = document.createElement("input");
        radioButton.type = "radio";
        radioButton.id = optionId;
        radioButton.name = `quiz-q-${index}`;
        radioButton.value = optionValue;
        optionLabel.appendChild(radioButton);
        optionLabel.appendChild(
          document.createTextNode(
            ` ${optionValue}) ${option || "[Missing Option]"}`
          )
        );
        optionsList.appendChild(optionLabel);
      });
      questionElement.appendChild(optionsList);

      const feedbackElement = document.createElement("div");
      feedbackElement.classList.add("quiz-feedback");
      feedbackElement.style.display = "none";
      questionElement.appendChild(feedbackElement);

      quizQuestionsDiv.appendChild(questionElement);
    });

    // Add Submit Button dynamically
    document.getElementById("submit-quiz-button")?.remove(); // Remove old one if exists
    submitQuizButton = document.createElement("button"); // Re-assign global variable
    submitQuizButton.id = "submit-quiz-button";
    submitQuizButton.textContent = "Submit Answers";
    submitQuizButton.classList.add("action-button", "main-action");
    submitQuizButton.style.marginTop = "20px";
    submitQuizButton.addEventListener("click", handleSubmitQuiz);
    quizQuestionsDiv.appendChild(submitQuizButton);

    quizErrorDiv.style.display = "none"; // Ensure error div is hidden
  }

  // --- Helper Function to handle quiz submission ---
  function handleSubmitQuiz() {
    console.log("Handling quiz submission.");
    if (!currentQuizData) {
      console.error("No quiz data available to submit.");
      return;
    }
    if (!quizQuestionsDiv || !quizAreaDiv) {
      console.error(
        "Cannot handle submit, essential display elements missing."
      );
      return;
    }

    let score = 0;
    let totalQuestions = currentQuizData.length;
    let allAnswered = true;

    currentQuizData.forEach((q, index) => {
      const questionElement = quizQuestionsDiv.querySelector(
        `.quiz-question-item[data-question-index="${index}"]`
      );
      // Check if elements exist before accessing properties
      if (!questionElement) {
        console.error(`Could not find question element for index ${index}`);
        return; // Skip this question if element not found
      }
      const feedbackElement = questionElement.querySelector(".quiz-feedback");
      const radioButtons = questionElement.querySelectorAll(
        `input[name="quiz-q-${index}"]`
      );
      const correctAnswer = (q.correct_answer || "").toUpperCase();

      if (!feedbackElement || radioButtons.length === 0) {
        console.error(
          `Could not find feedback element or radio buttons for question index ${index}`
        );
        return; // Skip this question
      }

      let selectedAnswer = null;
      radioButtons.forEach((radio) => {
        if (radio.checked) {
          selectedAnswer = radio.value;
        }
        radio.disabled = true; // Disable radio buttons after submission
      });

      feedbackElement.style.display = "block";
      feedbackElement.classList.remove("correct", "incorrect", "unanswered");

      if (!selectedAnswer) {
        allAnswered = false;
        feedbackElement.textContent = `⚠️ Please select an answer. Correct answer: ${correctAnswer}`;
        feedbackElement.classList.add("unanswered");
      } else if (selectedAnswer === correctAnswer) {
        score++;
        feedbackElement.textContent = `✔️ Correct!`;
        feedbackElement.classList.add("correct");
        const correctLabel = questionElement.querySelector(
          `input[value="${correctAnswer}"]`
        )?.parentNode; // Optional chaining
        if (correctLabel) correctLabel.classList.add("correct-answer-label");
      } else {
        feedbackElement.textContent = `❌ Incorrect. Correct answer was: ${correctAnswer}`;
        feedbackElement.classList.add("incorrect");
        const correctLabel = questionElement.querySelector(
          `input[value="${correctAnswer}"]`
        )?.parentNode;
        if (correctLabel) correctLabel.classList.add("correct-answer-label");
        const wrongLabel = questionElement.querySelector(
          `input[value="${selectedAnswer}"]`
        )?.parentNode;
        if (wrongLabel) wrongLabel.classList.add("incorrect-answer-label");
      }
    }); // End loop

    // Display Overall Score
    document.getElementById("quiz-score-display")?.remove(); // Remove old score
    const scoreDisplay = document.createElement("div");
    scoreDisplay.id = "quiz-score-display";
    scoreDisplay.classList.add("quiz-score");
    scoreDisplay.innerHTML = `<h3>Your Score: ${score} / ${totalQuestions}</h3>`;
    if (!allAnswered) {
      scoreDisplay.innerHTML += `<p style="color: orange; font-weight: bold;">(Some questions were unanswered)</p>`;
    }
    // Append score to the main quiz area, not just questions div
    quizAreaDiv.appendChild(scoreDisplay);

    // Disable Submit button
    if (submitQuizButton) {
      submitQuizButton.disabled = true;
      submitQuizButton.textContent = "Submitted";
    }
    // Optionally show the "Show Answers" button now if it exists and wasn't clicked
    // if (showAnswersButton && showAnswersButton.style.display === 'none') {
    //    showAnswersButton.style.display = 'inline-block';
    // }

    console.log(
      `Quiz submitted. Score: ${score}/${totalQuestions}. Ready to save attempt.`
    );
    // TODO: Call function to save attempt to backend here
    saveQuizAttemptToServer(
      currentQuizData,
      getUserAnswers(),
      score,
      totalQuestions
    );
  } // End handleSubmitQuiz

  // --- Helper Function to display static answers (used by Show Answers button) ---
  function displayQuizAnswers(quizData) {
    if (!quizAnswersDiv) {
      console.error("Cannot display answers, quizAnswersDiv missing.");
      return;
    }
    if (!quizData) {
      console.warn("Cannot display answers, no quiz data.");
      return;
    }

    quizAnswersDiv.innerHTML = "<h4>Correct Answers:</h4>";
    const answerList = document.createElement("ul");
    quizData.forEach((q, index) => {
      const answerItem = document.createElement("li");
      const correctLetter = (q.correct_answer || "?").toUpperCase();
      const correctIndex = correctLetter.charCodeAt(0) - 65;
      let correctText = "[Invalid Answer Key]";
      if (q.options && q.options.length > correctIndex && correctIndex >= 0) {
        correctText = q.options[correctIndex] || "[Missing Option Text]";
      }
      answerItem.textContent = `${index + 1}: ${correctLetter}) ${correctText}`;
      answerList.appendChild(answerItem);
    });
    quizAnswersDiv.appendChild(answerList);
    quizAnswersDiv.style.display = "block"; // Make sure it's visible
  }

  // --- Helper Function to display quiz errors ---
  function displayQuizError(errorMessage) {
    if (!quizErrorDiv || !quizAreaDiv || !quizLoadingDiv) {
      console.error("Cannot display quiz error, essential elements missing.");
      console.error("Error message was:", errorMessage); // Log the error regardless
      return;
    }
    quizErrorDiv.textContent = `Error: ${errorMessage}`;
    quizErrorDiv.style.display = "block";
    quizAreaDiv.style.display = "none";
    quizLoadingDiv.style.display = "none";
    // Ensure dynamic elements are removed on error too
    document.getElementById("submit-quiz-button")?.remove();
    document.getElementById("quiz-score-display")?.remove();
  }

  // Uncomment and complete this function in main.js
  function getUserAnswers() {
    const answers = {}; // Store answers as { questionIndex: selectedValue }
    if (!currentQuizData || !quizQuestionsDiv) return answers; // Return empty if no data/div

    currentQuizData.forEach((q, index) => {
      const selectedRadio = quizQuestionsDiv.querySelector(
        `input[name="quiz-q-${index}"]:checked`
      );
      answers[index] = selectedRadio ? selectedRadio.value : null; // Store 'A', 'B', 'C', 'D' or null
    });
    return answers;
  }

  // Add this new function in main.js
  async function saveQuizAttemptToServer(
    quizData,
    userAnswers,
    score,
    totalQuestions
  ) {
    if (!quizData) return; // Don't save if there's no quiz

    // Attempt to get the subject from the main container's data attribute
    const container = document.querySelector(".container[data-subject]");
    const subject = container ? container.dataset.subject : "unknown"; // Default if not found

    const dataToSend = {
      originalQuiz: quizData, // The array of question objects
      userSelections: userAnswers, // The object {0: 'A', 1: 'C', ...}
      score: score,
      totalQuestions: totalQuestions,
      subject: subject,
    };

    console.log("Sending quiz attempt data to server:", dataToSend);

    try {
      const response = await fetch("/save-quiz-attempt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(dataToSend),
      });

      const result = await response.json();

      if (response.ok && result.success) {
        console.log("Quiz attempt saved successfully.");
        // Optional: Show a small success message to the user
        // e.g., display a temporary "Saved!" message near the score.
      } else {
        console.error(
          "Failed to save quiz attempt:",
          result.error || "Unknown error"
        );
        // Optional: Show an error message to the user
        // alert(`Failed to save quiz attempt: ${result.error || 'Unknown error'}`);
      }
    } catch (error) {
      console.error("Network error saving quiz attempt:", error);
      // Optional: Show a network error message
      // alert("Network error: Could not save quiz attempt.");
    }
  }

  // === END REVISED Quiz Generation Feature Block ===

  // --- Feature: History Battle Flow ---
  const battleSelect = document.getElementById("battle-select");
  const generateFlowButton = document.getElementById("generate-flow-button");
  const flowLoadingDiv = document.getElementById("flow-loading");
  const flowResultDiv = document.getElementById("flow-result");
  const flowErrorDiv = document.getElementById("flow-error");

  if (
    battleSelect &&
    generateFlowButton &&
    flowLoadingDiv &&
    flowResultDiv &&
    flowErrorDiv
  ) {
    console.log("History Battle Flow elements found.");
    generateFlowButton.addEventListener("click", async () => {
      const selectedBattle = battleSelect.value;
      console.log("Generate Flow button clicked for battle:", selectedBattle);

      if (!selectedBattle) {
        displayFlowError("Please select a battle from the list.");
        return;
      }

      // Reset UI
      flowLoadingDiv.style.display = "block";
      flowResultDiv.style.display = "none";
      flowResultDiv.innerHTML = "";
      flowErrorDiv.style.display = "none";

      try {
        console.log("Sending selected battle for event flow...");
        const response = await fetch("/generate-battle-flow", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ battle: selectedBattle }),
        });

        flowLoadingDiv.style.display = "none";
        const data = await response.json();

        if (!response.ok) {
          const errorMsg =
            data.error ||
            `HTTP error! status: ${response.status} ${response.statusText}`;
          console.error("Battle flow generation failed:", errorMsg);
          displayFlowError(errorMsg);
        } else {
          console.log("Battle flow received:", data.flow);
          displayFlowResult(data.flow);
        }
      } catch (error) {
        console.error("Error during battle flow fetch operation:", error);
        flowLoadingDiv.style.display = "none";
        displayFlowError(
          "An network or unexpected error occurred. Please check the console."
        );
      }
    });
  } else {
    console.log("History Battle Flow elements not found on this page.");
  }

  function displayFlowResult(flowText) {
    flowResultDiv.innerHTML = ""; // Clear previous content
    // Attempt to format simple markdown lists into HTML lists
    const lines = (flowText || "").split("\n");
    let htmlContent = "";
    let listType = null; // null, 'ul', 'ol'

    lines.forEach((line) => {
      const trimmedLine = line.trim();
      let currentItemType = null; // null, 'ul', 'ol'
      let itemText = "";

      if (trimmedLine.startsWith("* ") || trimmedLine.startsWith("- ")) {
        currentItemType = "ul";
        itemText = trimmedLine.substring(2);
      } else if (trimmedLine.match(/^\d+\.\s/)) {
        currentItemType = "ol";
        itemText = trimmedLine.replace(/^\d+\.\s/, "");
      }

      if (currentItemType) {
        // Starting a new list or switching list type?
        if (listType !== currentItemType) {
          if (listType) htmlContent += `</${listType}>`; // Close previous list
          listType = currentItemType;
          htmlContent += `<${listType}>`;
        }
        // Add list item (safely using textContent)
        const li = document.createElement("li");
        li.textContent = itemText;
        htmlContent += li.outerHTML;
      } else {
        // Not a list item, close any open list
        if (listType) {
          htmlContent += `</${listType}>`;
          listType = null;
        }
        // Add non-empty lines as paragraphs (safely using textContent)
        if (trimmedLine.length > 0) {
          const p = document.createElement("p");
          p.textContent = trimmedLine;
          htmlContent += p.outerHTML;
        }
      }
    });

    // Close any list that might still be open at the end
    if (listType) {
      htmlContent += `</${listType}>`;
    }

    // Fallback if no formatting was possible, just use paragraphs
    if (htmlContent.trim() === "" && flowText.trim() !== "") {
      const p = document.createElement("p");
      p.textContent = flowText; // Put entire text in one paragraph
      htmlContent = p.outerHTML;
    }

    flowResultDiv.innerHTML = htmlContent; // Set the formatted HTML
    flowResultDiv.className = "result-box success";
    flowResultDiv.style.display = "block";
  }

  function displayFlowError(errorMessage) {
    flowErrorDiv.textContent = `Error: ${errorMessage}`;
    flowErrorDiv.className = "result-box error";
    flowErrorDiv.style.display = "block";
    flowResultDiv.style.display = "none"; // Hide result area on error
    flowLoadingDiv.style.display = "none";
  }

  // // --- Feature: Geography Map Visualization ---
  // const mapContainer = document.getElementById("map");
  // const geoTopicInput = document.getElementById("geo-topic-input");
  // const generateMapButton = document.getElementById("generate-map-button");
  // const mapLoadingDiv = document.getElementById("map-loading");
  // const mapInfoDiv = document.getElementById("map-info");
  // const mapErrorDiv = document.getElementById("map-error");

  // let map = null; // Leaflet map instance
  // let currentMarkers = []; // Array to track map markers

  // let currentBoundsRect = null; // Variable to hold the bounds rectangle layer

  // // Initialize Map ONLY if the map container and Leaflet (L) are available
  // if (mapContainer && typeof L !== "undefined") {
  //   console.log("Map container found, initializing Leaflet map.");
  //   try {
  //     // Initialize the map
  //     map = L.map("map").setView([20, 0], 2); // Default view

  //     // Add OpenStreetMap tile layer
  //     L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  //       maxZoom: 18, // Slightly lower max zoom
  //       attribution:
  //         '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  //     }).addTo(map);

  //     console.log("Leaflet map initialized successfully.");

  //     // Now, add the event listener if map init was successful
  //     if (generateMapButton && geoTopicInput) {
  //       console.log("Geo Map button and input found.");
  //       generateMapButton.addEventListener("click", async () => {
  //         const topic = geoTopicInput.value.trim();
  //         console.log("Generate Map button clicked for topic:", topic);

  //         if (!topic) {
  //           displayMapError("Please enter a geographical topic.");
  //           return;
  //         }

  //         // Reset UI
  //         mapLoadingDiv.style.display = "block";
  //         mapInfoDiv.style.display = "none";
  //         mapInfoDiv.innerHTML = "";
  //         mapErrorDiv.style.display = "none";
  //         clearMapMarkers(); // Remove old markers

  //         try {
  //           console.log("Sending topic for map info...");
  //           const response = await fetch("/generate-map-info", {
  //             method: "POST",
  //             headers: { "Content-Type": "application/json" },
  //             body: JSON.stringify({ topic: topic }),
  //           });

  //           mapLoadingDiv.style.display = "none";
  //           const data = await response.json();

  //           if (!response.ok) {
  //             const errorMsg =
  //               data.error ||
  //               `HTTP error! status: ${response.status} ${response.statusText}`;
  //             console.error("Map info generation failed:", errorMsg);
  //             displayMapError(errorMsg);
  //           } else {
  //             console.log("Map info data received:", data);
  //             // Validate essential map data
  //             if (
  //               data &&
  //               (typeof data.center_lat === "number" ||
  //                 data.center_lat === null) &&
  //               (typeof data.center_lon === "number" ||
  //                 data.center_lon === null)
  //             ) {
  //               // 1. Fit Bounds if available and valid
  //               let boundsFitted = false;
  //               if (
  //                 data.bounding_box &&
  //                 typeof data.bounding_box.south_west_lat === "number" &&
  //                 typeof data.bounding_box.south_west_lon === "number" &&
  //                 typeof data.bounding_box.north_east_lat === "number" &&
  //                 typeof data.bounding_box.north_east_lon === "number"
  //               ) {
  //                 const sw = L.latLng(
  //                   data.bounding_box.south_west_lat,
  //                   data.bounding_box.south_west_lon
  //                 );
  //                 const ne = L.latLng(
  //                   data.bounding_box.north_east_lat,
  //                   data.bounding_box.north_east_lon
  //                 );
  //                 const bounds = L.latLngBounds(sw, ne);

  //                 if (bounds.isValid()) {
  //                   console.log("Fitting map to bounds:", bounds);
  //                   map.fitBounds(bounds, { padding: [20, 20] }); // Add padding
  //                   boundsFitted = true;

  //                   // Optional: Draw the bounding box rectangle
  //                   // currentBoundsRect = L.rectangle(bounds, { color: "#ff7800", weight: 1, fillOpacity: 0.1 }).addTo(map);
  //                   // currentMarkers.push(currentBoundsRect); // Add to track for clearing
  //                 } else {
  //                   console.warn("Received invalid bounding box coordinates.");
  //                 }
  //               }

  //               // 2. Set Center/Zoom if bounds were NOT fitted (fallback)
  //               if (
  //                 !boundsFitted &&
  //                 data.center_lat !== null &&
  //                 data.center_lon !== null
  //               ) {
  //                 const zoom =
  //                   typeof data.zoom === "number" &&
  //                   data.zoom >= 1 &&
  //                   data.zoom <= 18
  //                     ? data.zoom
  //                     : 10; // Default zoom if bounds fail
  //                 console.log(
  //                   `Setting map view to center [${data.center_lat}, ${data.center_lon}], zoom ${zoom}`
  //                 );
  //                 map.setView([data.center_lat, data.center_lon], zoom);
  //               } else if (!boundsFitted) {
  //                 // If no bounds AND no center, reset view
  //                 console.log("No valid bounds or center, resetting map view.");
  //                 map.setView([20, 0], 2);
  //               }

  //               // // Update map view if coordinates are valid
  //               // if (data.center_lat !== null && data.center_lon !== null) {
  //               //   const zoom =
  //               //     typeof data.zoom === "number" &&
  //               //     data.zoom >= 1 &&
  //               //     data.zoom <= 18
  //               //       ? data.zoom
  //               //       : 5; // Default zoom if invalid
  //               //   map.setView([data.center_lat, data.center_lon], zoom);
  //               // } else {
  //               //   // If no center, maybe just reset to default view? Or keep current view.
  //               //   map.setView([20, 0], 2); // Reset to global view
  //               //   console.log(
  //               //     "No valid center coordinates provided by AI, resetting map view."
  //               //   );
  //               // }

  //               //3. Display description
  //               if (data.description) {
  //                 const safeDesc = document.createElement("p");
  //                 safeDesc.textContent = data.description;
  //                 const header = document.createElement("h4");
  //                 header.textContent = `About: ${topic}`;
  //                 mapInfoDiv.innerHTML = ""; // Clear first
  //                 mapInfoDiv.appendChild(header);
  //                 mapInfoDiv.appendChild(safeDesc);
  //                 if (typeof showResultAndButton === "function")
  //                   showResultAndButton("map-info"); // Show div and TTS button
  //                 else mapInfoDiv.style.display = "block"; // Fallback
  //               } else {
  //                 mapInfoDiv.style.display = "none";
  //                 const button = document.querySelector(
  //                   '.read-aloud-button[data-target="map-info"]'
  //                 );
  //                 if (button) button.style.display = "none";
  //               }

  //               // 4 Add points of interest markers
  //               if (
  //                 data.points_of_interest &&
  //                 Array.isArray(data.points_of_interest)
  //               ) {
  //                 addMarkersToMap(data.points_of_interest);
  //               }
  //             } else {
  //               console.error(
  //                 "Received map data is incomplete or invalid:",
  //                 data
  //               );
  //               displayMapError(
  //                 "Received invalid map data structure from the server."
  //               );
  //             }
  //           }
  //         } catch (error) {
  //           console.error("Error during map info fetch operation:", error);
  //           mapLoadingDiv.style.display = "none";
  //           displayMapError(
  //             "An network or unexpected error occurred. Please check the console."
  //           );
  //         }
  //       }); // End generateMapButton listener
  //     } else {
  //       console.warn("Geo map button/input not found, listener not added.");
  //     } // End if (button/input exist)
  //   } catch (error) {
  //     // Catch Leaflet initialization error
  //     console.error("CRITICAL: Error initializing Leaflet map:", error);
  //     if (mapErrorDiv) {
  //       // Display error if the div exists
  //       mapErrorDiv.textContent =
  //         "Error initializing the map. Please ensure you are connected to the internet and Leaflet library is loaded correctly, then try refreshing.";
  //       mapErrorDiv.style.display = "block";
  //     }
  //   } // End try/catch map init
  // } else {
  //   if (!mapContainer)
  //     console.log("Map container (#map) not found on this page.");
  //   if (typeof L === "undefined")
  //     console.error(
  //       "Leaflet library (L) is not defined. Check script loading order or CDN link in HTML."
  //     );
  // } // End if (mapContainer && Leaflet exists)

  // // Helper function to remove existing markers from map
  // function clearMapMarkers() {
  //   if (!map) return; // Safety check
  //   console.log(
  //     `Clearing ${currentMarkers.length} map layers (markers/bound).`
  //   );
  //   currentMarkers.forEach((marker) => map.removeLayer(marker));
  //   currentMarkers = [];
  // }

  // // Helper function to add new markers based on AI data
  // function addMarkersToMap(points) {
  //   if (!map) return; // Safety check
  //   console.log(`Adding ${points.length} markers to map.`);
  //   points.forEach((point) => {
  //     // Validate point data before adding marker
  //     if (
  //       typeof point.lat === "number" &&
  //       typeof point.lon === "number" &&
  //       point.name &&
  //       typeof point.name === "string" &&
  //       point.popup_info &&
  //       typeof point.popup_info === "string"
  //     ) {
  //       // Basic lat/lon range check
  //       if (
  //         point.lat >= -90 &&
  //         point.lat <= 90 &&
  //         point.lon >= -180 &&
  //         point.lon <= 180
  //       ) {
  //         const marker = L.marker([point.lat, point.lon]).addTo(map);
  //         // Create safe popup content
  //         const popupContent = document.createElement("div");
  //         const nameStrong = document.createElement("strong");
  //         nameStrong.textContent = point.name;
  //         popupContent.appendChild(nameStrong);
  //         popupContent.appendChild(document.createElement("br"));
  //         popupContent.appendChild(document.createTextNode(point.popup_info));
  //         marker.bindPopup(popupContent);

  //         currentMarkers.push(marker); // Track added marker
  //       } else {
  //         console.warn("Skipping point with out-of-bounds coordinates:", point);
  //       }
  //     } else {
  //       console.warn("Skipping invalid point of interest data:", point);
  //     }
  //   });
  // }

  // // Helper function to display errors for the map feature
  // function displayMapError(errorMessage) {
  //   if (mapErrorDiv) {
  //     mapErrorDiv.textContent = `Error: ${errorMessage}`;
  //     mapErrorDiv.className = "result-box error";
  //     mapErrorDiv.style.display = "block";
  //   } else {
  //     console.error("Map error occurred, but error display element not found.");
  //   }
  //   // Hide other map elements on error
  //   if (mapLoadingDiv) mapLoadingDiv.style.display = "none";
  //   if (mapInfoDiv) mapInfoDiv.style.display = "none";
  // }

  // // --- End of Geography Feature ---

  // === REPLACE THE ENTIRE Geography Map Feature Block WITH THIS ===
  console.log("Setting up Geography Map feature...");

  const mapContainer = document.getElementById("map");
  const geoTopicInput = document.getElementById("geo-topic-input");
  const generateMapButton = document.getElementById("generate-map-button");
  const mapLoadingDiv = document.getElementById("map-loading");
  const mapInfoDiv = document.getElementById("map-info");
  const mapErrorDiv = document.getElementById("map-error");
  const mapTtsButton = document.querySelector(
    '.read-aloud-button[data-target="map-info"]'
  ); // TTS Button

  let map = null; // Leaflet map instance
  let currentMapLayers = []; // Array to track ALL layers added (markers, bounds)

  // --- Initialize Map ONLY if the map container and Leaflet (L) are available ---
  if (mapContainer && typeof L !== "undefined") {
    console.log("Map container and Leaflet found, initializing Leaflet map.");
    try {
      // Initialize the map
      map = L.map("map", {
        // Optional: Add worldCopyJump: true if users might pan across the date line
      }).setView([20, 0], 2); // Default view

      // Add OpenStreetMap tile layer
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 18,
        attribution:
          '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      }).addTo(map);

      console.log("Leaflet map initialized successfully.");

      // --- Add Event Listener for Generate Map Button (only if map init succeeded) ---
      if (generateMapButton && geoTopicInput) {
        console.log("Geo Map button and input found. Attaching listener.");
        generateMapButton.addEventListener("click", async () => {
          const topic = geoTopicInput.value.trim();
          console.log("Generate Map button clicked for topic:", topic);

          if (!topic) {
            displayMapError("Please enter a geographical topic.");
            return;
          }

          // Reset UI before fetch
          mapLoadingDiv.style.display = "block";
          mapInfoDiv.style.display = "none";
          mapInfoDiv.innerHTML = "";
          mapErrorDiv.style.display = "none";
          if (mapTtsButton) mapTtsButton.style.display = "none"; // Hide TTS button
          clearMapLayers(); // Clear previous markers AND bounds rectangle

          try {
            console.log("Sending topic for map info...");
            const response = await fetch("/generate-map-info", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ topic: topic }),
            });

            mapLoadingDiv.style.display = "none"; // Hide loading indicator

            if (!response.ok) {
              // Handle HTTP errors
              let errorMsg = `HTTP error! status: ${response.status} ${response.statusText}`;
              try {
                const errorData = await response.json();
                errorMsg = errorData.error || errorMsg;
              } catch (e) {
                console.warn(
                  "Could not parse JSON from map error response:",
                  e
                );
              }
              console.error("Map info generation failed:", errorMsg);
              displayMapError(errorMsg);
            } else {
              // Handle successful response
              const data = await response.json();
              console.log("Map info data received:", data);

              // Validate essential structure (basic check)
              if (!data || typeof data !== "object") {
                console.error(
                  "Received invalid map data structure (not an object):",
                  data
                );
                displayMapError(
                  "Received invalid map data structure from the server."
                );
                return; // Stop processing
              }

              // --- Update Map View (Bounds or Center/Zoom) ---
              let boundsFitted = false;
              // Check if bounding_box exists and has all necessary numeric properties
              if (
                data.bounding_box &&
                typeof data.bounding_box.south_west_lat === "number" &&
                typeof data.bounding_box.south_west_lon === "number" &&
                typeof data.bounding_box.north_east_lat === "number" &&
                typeof data.bounding_box.north_east_lon === "number"
              ) {
                try {
                  const sw = L.latLng(
                    data.bounding_box.south_west_lat,
                    data.bounding_box.south_west_lon
                  );
                  const ne = L.latLng(
                    data.bounding_box.north_east_lat,
                    data.bounding_box.north_east_lon
                  );
                  const bounds = L.latLngBounds(sw, ne);

                  if (bounds.isValid()) {
                    console.log(
                      "Fitting map to bounds:",
                      bounds.toBBoxString()
                    );
                    map.fitBounds(bounds, { padding: [30, 30] }); // Increased padding
                    boundsFitted = true;

                    // Optional: Draw the bounding box rectangle
                    const boundsRect = L.rectangle(bounds, {
                      color: "#3498db",
                      weight: 2,
                      fillOpacity: 0.05,
                    }).addTo(map);
                    currentMapLayers.push(boundsRect); // Add to track for clearing
                  } else {
                    console.warn(
                      "Received bounding box coordinates resulted in invalid bounds."
                    );
                  }
                } catch (boundsError) {
                  console.error("Error creating LatLngBounds:", boundsError);
                }
              } else {
                console.log("No valid bounding_box data received.");
              }

              // Fallback to center/zoom if bounds weren't fitted
              if (!boundsFitted) {
                if (
                  data.center_lat !== null &&
                  data.center_lon !== null &&
                  typeof data.center_lat === "number" &&
                  typeof data.center_lon === "number"
                ) {
                  const zoom =
                    typeof data.zoom === "number" &&
                    data.zoom >= 1 &&
                    data.zoom <= 18
                      ? data.zoom
                      : 10; // Sensible default zoom
                  console.log(
                    `Setting map view to center [${data.center_lat}, ${data.center_lon}], zoom ${zoom}`
                  );
                  map.setView([data.center_lat, data.center_lon], zoom);
                } else {
                  // If no bounds AND no center, reset view
                  console.log(
                    "No valid bounds or center, resetting map view to default."
                  );
                  map.setView([20, 0], 2);
                }
              }

              // --- Display Description ---
              if (data.description && typeof data.description === "string") {
                const safeDesc = document.createElement("p");
                safeDesc.textContent = data.description;
                const header = document.createElement("h4");
                header.textContent = `About: ${topic}`; // Use the original topic input
                mapInfoDiv.innerHTML = ""; // Clear previous
                mapInfoDiv.appendChild(header);
                mapInfoDiv.appendChild(safeDesc);
                // Use helper to show div and button
                if (typeof showResultAndButton === "function") {
                  showResultAndButton("map-info");
                } else {
                  // Fallback
                  mapInfoDiv.style.display = "block";
                  if (mapTtsButton) mapTtsButton.style.display = "inline-block";
                }
              } else {
                mapInfoDiv.style.display = "none"; // Hide if no description
                if (mapTtsButton) mapTtsButton.style.display = "none";
              }

              // --- Add Points of Interest Markers ---
              if (
                data.points_of_interest &&
                Array.isArray(data.points_of_interest)
              ) {
                addMarkersToMap(data.points_of_interest);
              }
            } // End else (response.ok)
          } catch (error) {
            // Catch fetch/network errors
            console.error("Error during map info fetch operation:", error);
            mapLoadingDiv.style.display = "none";
            displayMapError(
              "A network or unexpected error occurred. Please check the console."
            );
          } // End try/catch fetch
        }); // End button listener
      } else {
        console.warn("Geo map button or input not found, listener not added.");
      } // End if (button/input exist)
    } catch (error) {
      // Catch Leaflet initialization error
      console.error("CRITICAL: Error initializing Leaflet map:", error);
      if (mapErrorDiv) {
        mapErrorDiv.textContent =
          "Error initializing the map. Please ensure you are connected to the internet and Leaflet library is loaded correctly, then try refreshing.";
        mapErrorDiv.style.display = "block";
      }
    } // End try/catch map init
  } else {
    // Log reason if map init failed
    if (!mapContainer)
      console.log("Map container (#map) not found on this page.");
    if (typeof L === "undefined")
      console.error(
        "Leaflet library (L) is not defined. Check script loading order or CDN link in HTML."
      );
  } // End if (mapContainer && Leaflet exists)

  // --- Helper function to clear ALL map layers (markers, bounds) ---
  function clearMapLayers() {
    if (!map) return;
    console.log(`Clearing ${currentMapLayers.length} map layers.`);
    currentMapLayers.forEach((layer) => {
      try {
        map.removeLayer(layer);
      } catch (removeError) {
        console.warn("Error removing layer:", layer, removeError);
      }
    });
    currentMapLayers = []; // Reset the array
  }

  // --- Helper function to add markers (Points of Interest) ---
  function addMarkersToMap(points) {
    if (!map) {
      console.error("Cannot add markers, map is not initialized.");
      return;
    }
    console.log(`Adding ${points.length} POI markers to map.`);
    points.forEach((point) => {
      // Validate point data before adding marker
      if (
        typeof point.lat === "number" &&
        typeof point.lon === "number" &&
        point.name &&
        typeof point.name === "string"
      ) {
        // popup_info is optional now
        if (
          point.lat >= -90 &&
          point.lat <= 90 &&
          point.lon >= -180 &&
          point.lon <= 180
        ) {
          const marker = L.marker([point.lat, point.lon]).addTo(map);
          // Create safe popup content
          const popupContent = document.createElement("div");
          const nameStrong = document.createElement("strong");
          nameStrong.textContent = point.name;
          popupContent.appendChild(nameStrong);
          // Add popup info only if it exists and is not empty
          if (
            point.popup_info &&
            typeof point.popup_info === "string" &&
            point.popup_info.trim()
          ) {
            popupContent.appendChild(document.createElement("br"));
            popupContent.appendChild(document.createTextNode(point.popup_info));
          }
          marker.bindPopup(popupContent);
          currentMapLayers.push(marker); // Track added marker
        } else {
          console.warn("Skipping POI with out-of-bounds coordinates:", point);
        }
      } else {
        console.warn("Skipping invalid point of interest data:", point);
      }
    });
  }

  // --- Helper function to display map errors ---
  function displayMapError(errorMessage) {
    if (mapErrorDiv) {
      mapErrorDiv.textContent = `Error: ${errorMessage}`;
      mapErrorDiv.className = "result-box error";
      mapErrorDiv.style.display = "block";
    } else {
      console.error("Map error occurred, but error display element not found.");
    }
    // Hide other map elements on error
    if (mapLoadingDiv) mapLoadingDiv.style.display = "none";
    if (mapInfoDiv) mapInfoDiv.style.display = "none";
    if (mapTtsButton) mapTtsButton.style.display = "none";
  }

  // === END REVISED Geography Map Feature Block ===

  // === NEW SECTION: Crossword Helper Feature ===
  const generateCrosswordButton = document.getElementById(
    "generate-crossword-button"
  );
  const crosswordSourceText = document.getElementById("crossword-source-text");
  const crosswordLoadingDiv = document.getElementById("crossword-loading");
  const crosswordResultDiv = document.getElementById("crossword-result"); // The container div
  const crosswordListDiv = document.getElementById("crossword-list"); // The inner div for the list
  const crosswordErrorDiv = document.getElementById("crossword-error");

  if (
    generateCrosswordButton &&
    crosswordSourceText &&
    crosswordLoadingDiv &&
    crosswordResultDiv &&
    crosswordListDiv &&
    crosswordErrorDiv
  ) {
    console.log("Crossword Helper elements found.");
    generateCrosswordButton.addEventListener("click", async () => {
      console.log("Generate Crossword button clicked.");
      const sourceText = crosswordSourceText.value.trim();

      if (!sourceText) {
        displayCrosswordError("Please enter a topic or paste some text.");
        return;
      }

      // Reset UI
      crosswordLoadingDiv.style.display = "block";
      crosswordResultDiv.style.display = "none"; // Hide the whole result area
      crosswordListDiv.innerHTML = ""; // Clear previous list
      crosswordErrorDiv.style.display = "none"; // Hide previous error

      try {
        console.log("Sending text for crossword data generation...");
        const response = await fetch("/generate-crossword-data", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: sourceText }),
        });

        crosswordLoadingDiv.style.display = "none";
        const data = await response.json();

        if (!response.ok) {
          const errorMsg =
            data.error ||
            `HTTP error! status: ${response.status} ${response.statusText}`;
          console.error("Crossword data generation failed:", errorMsg);
          displayCrosswordError(errorMsg);
        } else {
          if (
            data.crossword_data &&
            Array.isArray(data.crossword_data) &&
            data.crossword_data.length > 0
          ) {
            console.log("Crossword data received:", data.crossword_data);
            displayCrosswordData(data.crossword_data);
            crosswordResultDiv.style.display = "block"; // Show the result area
          } else {
            console.error(
              "Received success but no valid crossword data structure:",
              data
            );
            displayCrosswordError(
              "Failed to generate word/clue suggestions. The AI response might be empty or malformed."
            );
          }
        }
      } catch (error) {
        console.error("Error during crossword data fetch operation:", error);
        crosswordLoadingDiv.style.display = "none";
        displayCrosswordError(
          "An network or unexpected error occurred. Please check the console."
        );
      }
    });
  } else {
    console.log("Crossword Helper elements not found on this page.");
  }

  // Function to display the generated word/clue list
  function displayCrosswordData(data) {
    crosswordListDiv.innerHTML = ""; // Clear previous list content

    // Use a definition list (<dl>) for better structure
    const dl = document.createElement("dl");
    dl.classList.add("crossword-suggestions"); // Add class for styling

    data.forEach((item) => {
      if (item.word && item.clue) {
        const dt = document.createElement("dt"); // Term (Word)
        // Sanitize word - display as uppercase for crossword convention
        dt.textContent = (item.word || "").toUpperCase();

        const dd = document.createElement("dd"); // Definition (Clue)
        // Sanitize clue
        dd.textContent = item.clue || "[Missing Clue]";

        dl.appendChild(dt);
        dl.appendChild(dd);
      }
    });

    crosswordListDiv.appendChild(dl); // Add the definition list to the div
  }

  // Function to display errors for the crossword feature
  function displayCrosswordError(errorMessage) {
    crosswordErrorDiv.textContent = `Error: ${errorMessage}`;
    crosswordErrorDiv.className = "result-box error"; // Ensure error class is set
    crosswordErrorDiv.style.display = "block";
    crosswordResultDiv.style.display = "none"; // Hide result area on error
    crosswordLoadingDiv.style.display = "none";
  }
  // === END NEW SECTION ===

  // === REVISED Descriptive Writing Feedback Feature Block ===
  console.log("Setting up Writing Feedback (Dual Input) feature...");

  const getFeedbackButton = document.getElementById(
    "get-writing-feedback-button"
  );
  const writingTopicInput = document.getElementById("writing-topic");
  const writingAnswerTextArea = document.getElementById("writing-answer"); // Text input
  const writingAnswerFileInput = document.getElementById("writing-answer-file"); // File input
  const feedbackLoadingDiv = document.getElementById(
    "writing-feedback-loading"
  );
  const feedbackResultDiv = document.getElementById("writing-feedback-result");
  const feedbackErrorDiv = document.getElementById("writing-feedback-error");
  const feedbackTtsButton = document.querySelector(
    '.read-aloud-button[data-target="writing-feedback-result"]'
  );
  const writingInputMethodRadios = document.querySelectorAll(
    'input[name="writing-input-method"]'
  );
  const writingAnswerTextAreaDiv = document.getElementById(
    "writing-answer-text-area"
  );
  const writingAnswerFileAreaDiv = document.getElementById(
    "writing-answer-file-area"
  );

  // Check if all necessary elements exist
  if (
    getFeedbackButton &&
    writingTopicInput &&
    writingAnswerTextArea &&
    writingAnswerFileInput &&
    feedbackLoadingDiv &&
    feedbackResultDiv &&
    feedbackErrorDiv &&
    writingInputMethodRadios.length > 0 &&
    writingAnswerTextAreaDiv &&
    writingAnswerFileAreaDiv
  ) {
    console.log("Writing Feedback (Dual Input) elements found.");

    // --- Event Listener for Radio Buttons (Toggle Input Areas) ---
    writingInputMethodRadios.forEach((radio) => {
      radio.addEventListener("change", () => {
        if (radio.value === "text") {
          writingAnswerTextAreaDiv.style.display = "block";
          writingAnswerFileAreaDiv.style.display = "none";
          writingAnswerFileInput.value = ""; // Clear file input
        } else if (radio.value === "file") {
          writingAnswerTextAreaDiv.style.display = "none";
          writingAnswerFileAreaDiv.style.display = "block";
          writingAnswerTextArea.value = ""; // Clear text area
        }
      });
    });

    // --- Event Listener for the "Get Feedback" Button ---
    getFeedbackButton.addEventListener("click", async () => {
      console.log("Get Writing Feedback button clicked.");
      const topicQuestion = writingTopicInput.value.trim();
      const selectedMethod = document.querySelector(
        'input[name="writing-input-method"]:checked'
      ).value;

      // Validate topic/question first (always required)
      if (!topicQuestion) {
        displayWritingFeedbackError("Please enter the question or topic.");
        return;
      }

      let fetchOptions = { method: "POST" };
      let isValid = false;
      let bodyData = null; // Will hold JSON or FormData

      // --- Prepare Request based on Method ---
      if (selectedMethod === "text") {
        const userAnswer = writingAnswerTextArea.value.trim();
        if (!userAnswer) {
          displayWritingFeedbackError("Please type your answer.");
          return;
        }
        bodyData = JSON.stringify({
          topic_question: topicQuestion,
          user_answer: userAnswer,
          input_type: "text", // Indicate input type
        });
        fetchOptions.headers = { "Content-Type": "application/json" };
        fetchOptions.body = bodyData;
        isValid = true;
        feedbackLoadingDiv.textContent = "Analyzing typed answer...";
      } else if (selectedMethod === "file") {
        const file = writingAnswerFileInput.files[0];
        if (!file) {
          displayWritingFeedbackError(
            "Please select an answer file (.txt or .pdf)."
          );
          return;
        }
        // Basic client-side validation
        const fileName = file.name.toLowerCase();
        if (!fileName.endsWith(".txt") && !fileName.endsWith(".pdf")) {
          displayWritingFeedbackError(
            `Invalid file type. Please upload .txt or .pdf.`
          );
          writingAnswerFileInput.value = "";
          return;
        }

        bodyData = new FormData();
        bodyData.append("topic_question", topicQuestion); // Send topic along with file
        bodyData.append("answer_file", file); // Key must match backend
        bodyData.append("input_type", "file"); // Indicate input type
        // No Content-Type header needed for FormData
        fetchOptions.body = bodyData;
        isValid = true;
        feedbackLoadingDiv.textContent =
          "Processing file and analyzing answer...";
      }

      if (!isValid) {
        console.error("No valid input method or data for writing feedback.");
        return;
      }

      // --- Reset UI & Fetch ---
      feedbackLoadingDiv.style.display = "block";
      feedbackResultDiv.style.display = "none";
      feedbackResultDiv.innerHTML = "";
      feedbackErrorDiv.style.display = "none";
      if (feedbackTtsButton) feedbackTtsButton.style.display = "none";

      try {
        console.log("Sending request to /get-writing-feedback...");
        const response = await fetch("/get-writing-feedback", fetchOptions); // Use prepared options

        feedbackLoadingDiv.style.display = "none";
        const data = await response.json(); // Expect JSON response (feedback or error)

        if (!response.ok) {
          const errorMsg =
            data.error ||
            `HTTP error! status: ${response.status} ${response.statusText}`;
          console.error("Writing feedback generation failed:", errorMsg);
          displayWritingFeedbackError(errorMsg);
        } else {
          console.log("Writing feedback received.");
          displayWritingFeedbackResult(data.feedback); // Display the feedback
        }
      } catch (error) {
        console.error("Error during writing feedback fetch operation:", error);
        feedbackLoadingDiv.style.display = "none";
        displayWritingFeedbackError(
          "A network or unexpected error occurred. Please check the console."
        );
      } finally {
        // Clear file input after attempt
        writingAnswerFileInput.value = "";
      }
    }); // End button listener
  } else {
    console.log("Writing Feedback (Dual Input) elements not fully found.");
    // Add detailed checks if needed
  }

  // --- Helper functions for Writing Feedback ---
  function displayWritingFeedbackResult(feedbackText) {
    if (!feedbackResultDiv) return;
    // Use textContent to prevent potential HTML injection from AI response
    feedbackResultDiv.textContent = feedbackText;
    feedbackResultDiv.className = "result-box success"; // Use success class
    // Call helper to show div and TTS button (ensure showResultAndButton exists)
    if (typeof showResultAndButton === "function") {
      showResultAndButton("writing-feedback-result");
    } else {
      // Fallback if helper isn't available globally
      feedbackResultDiv.style.display = "block";
      const button = document.querySelector(
        '.read-aloud-button[data-target="writing-feedback-result"]'
      );
      if (button) button.style.display = "inline-block";
    }
  }

  function displayWritingFeedbackError(errorMessage) {
    if (!feedbackErrorDiv) return;
    feedbackErrorDiv.textContent = `Error: ${errorMessage}`;
    feedbackErrorDiv.className = "result-box error";
    feedbackErrorDiv.style.display = "block";
    // Hide other elements
    if (feedbackResultDiv) feedbackResultDiv.style.display = "none";
    if (feedbackLoadingDiv) feedbackLoadingDiv.style.display = "none";
    const button = document.querySelector(
      '.read-aloud-button[data-target="writing-feedback-result"]'
    );
    if (button) button.style.display = "none"; // Hide TTS button on error
  }
  // === END NEW SECTION ===

  // === NEW SECTION: Chemical Equation Balancer Feature ===
  console.log("Setting up Chemical Equation Balancer feature...");

  const balanceEquationButton = document.getElementById(
    "balance-equation-button"
  );
  const unbalancedEquationInput = document.getElementById(
    "unbalanced-equation"
  );
  const equationLoadingDiv = document.getElementById("equation-loading");
  const balancedEquationResultArea = document.getElementById(
    "balanced-equation-result-area"
  );
  const balancedEquationTextP = document.getElementById(
    "balanced-equation-text"
  );
  const equationExplanationResultArea = document.getElementById(
    "equation-explanation-result-area"
  );
  const equationExplanationTextDiv = document.getElementById(
    "equation-explanation-text"
  );
  const equationErrorDiv = document.getElementById("equation-error");
  const equationTtsButton = document.querySelector(
    '.read-aloud-button[data-target="equation-explanation-text"]'
  );

  // Check if elements exist
  if (
    balanceEquationButton &&
    unbalancedEquationInput &&
    equationLoadingDiv &&
    balancedEquationResultArea &&
    balancedEquationTextP &&
    equationExplanationResultArea &&
    equationExplanationTextDiv &&
    equationErrorDiv
  ) {
    console.log("Equation Balancer elements found. Attaching listener.");

    balanceEquationButton.addEventListener("click", async () => {
      console.log("Balance Equation button clicked.");
      const unbalancedEquation = unbalancedEquationInput.value.trim();

      if (!unbalancedEquation) {
        displayEquationError("Please enter an unbalanced chemical equation.");
        return;
      }

      // Reset UI
      equationLoadingDiv.style.display = "block";
      balancedEquationResultArea.style.display = "none";
      equationExplanationResultArea.style.display = "none";
      balancedEquationTextP.textContent = "";
      equationExplanationTextDiv.innerHTML = ""; // Use innerHTML if explanation might have formatting
      equationErrorDiv.style.display = "none";
      if (equationTtsButton) equationTtsButton.style.display = "none";

      try {
        console.log("Sending equation for balancing and explanation...");
        const response = await fetch("/balance-chemical-equation", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ equation: unbalancedEquation }),
        });

        equationLoadingDiv.style.display = "none";
        const data = await response.json();

        if (!response.ok) {
          const errorMsg =
            data.error ||
            `HTTP error! status: ${response.status} ${response.statusText}`;
          console.error("Equation balancing/explanation failed:", errorMsg);
          displayEquationError(errorMsg);
        } else {
          console.log("Equation data received:", data);
          // Display balanced equation
          balancedEquationTextP.textContent =
            data.balanced_equation || "Could not determine balanced equation.";
          balancedEquationResultArea.style.display = "block";

          // Display explanation (attempt to format if it contains list-like structures)
          const explanationHtml = formatTextWithLists(
            data.explanation || "No explanation provided."
          );
          equationExplanationTextDiv.innerHTML = explanationHtml;
          equationExplanationResultArea.style.display = "block";

          // Show TTS button for explanation
          if (
            equationTtsButton &&
            data.explanation &&
            data.explanation.trim()
          ) {
            equationTtsButton.style.display = "inline-block";
          }
        }
      } catch (error) {
        console.error(
          "Error during equation balancing fetch operation:",
          error
        );
        equationLoadingDiv.style.display = "none";
        displayEquationError(
          "A network or unexpected error occurred. Please check the console."
        );
      }
    }); // End button listener
  } else {
    console.log("Equation Balancer elements not fully found on this page.");
    // Add detailed checks if needed
    if (!balanceEquationButton) console.log("Missing: balance-equation-button");
    // etc.
  }

  // --- Helper function to display equation errors ---
  function displayEquationError(errorMessage) {
    if (!equationErrorDiv) return;
    equationErrorDiv.textContent = `Error: ${errorMessage}`;
    equationErrorDiv.className = "result-box error";
    equationErrorDiv.style.display = "block";
    // Hide other elements
    if (balancedEquationResultArea)
      balancedEquationResultArea.style.display = "none";
    if (equationExplanationResultArea)
      equationExplanationResultArea.style.display = "none";
    if (equationLoadingDiv) equationLoadingDiv.style.display = "none";
    if (equationTtsButton) equationTtsButton.style.display = "none";
  }

  // --- Reusable helper function to format text that might contain markdown-like lists ---
  // (You might already have a similar function from History Flow or Examples; adapt or reuse)
  function formatTextWithLists(text) {
    if (!text || typeof text !== "string") return "";
    const lines = text.split("\n");
    let htmlContent = "";
    let listType = null; // 'ul' or 'ol'

    lines.forEach((line) => {
      const trimmedLine = line.trim();
      let currentItemType = null;
      let itemText = "";

      if (trimmedLine.startsWith("* ") || trimmedLine.startsWith("- ")) {
        currentItemType = "ul";
        itemText = trimmedLine.substring(2);
      } else if (trimmedLine.match(/^\d+\.\s/)) {
        // Matches "1. ", "2. ", etc.
        currentItemType = "ol";
        itemText = trimmedLine.replace(/^\d+\.\s/, "");
      }

      if (currentItemType) {
        if (listType !== currentItemType) {
          // New list or changed type
          if (listType) htmlContent += `</${listType}>`; // Close previous list
          listType = currentItemType;
          htmlContent += `<${listType}>`;
        }
        const li = document.createElement("li");
        li.textContent = itemText; // Safely set text content
        htmlContent += li.outerHTML;
      } else {
        // Not a list item
        if (listType) {
          // If a list was open, close it
          htmlContent += `</${listType}>`;
          listType = null;
        }
        if (trimmedLine.length > 0) {
          // Add non-empty lines as paragraphs
          const p = document.createElement("p");
          p.textContent = trimmedLine; // Safely set text content
          htmlContent += p.outerHTML;
        } else if (
          htmlContent.length > 0 &&
          !htmlContent.endsWith("</p>") &&
          !htmlContent.endsWith("</ul>") &&
          !htmlContent.endsWith("</ol>")
        ) {
          // Add a line break for empty lines between paragraphs or after lists, but not if it's just empty.
          // This helps preserve paragraph spacing from the AI.
          // htmlContent += '<br>'; // Or handle spacing with CSS margins on <p>, <ul>, <ol>
        }
      }
    });
    if (listType) {
      htmlContent += `</${listType}>`;
    } // Close any open list at the end

    return htmlContent.trim() ? htmlContent : `<p>${text}</p>`; // Fallback if no formatting applied
  }

  // === END NEW SECTION ===

  // === NEW SECTION: Biological Process Explainer Feature ===
  console.log("Setting up Biological Process Explainer feature...");

  const explainProcessButton = document.getElementById(
    "explain-process-button"
  );
  const biologicalProcessInput = document.getElementById("biological-process");
  const processLoadingDiv = document.getElementById("process-loading");
  const processExplanationResultDiv = document.getElementById(
    "process-explanation-result"
  );
  const processNameHeading = document.getElementById("process-name-heading");
  const processOverviewDiv = document.getElementById("process-overview");
  const processStagesDiv = document.getElementById("process-stages");
  const processIODiv = document.getElementById("process-io");
  const processSignificanceDiv = document.getElementById(
    "process-significance"
  );
  const processErrorDiv = document.getElementById("process-error");
  const processTtsButton = document.querySelector(
    '.read-aloud-button[data-target="process-explanation-result"]'
  );

  // Check if elements exist
  if (
    explainProcessButton &&
    biologicalProcessInput &&
    processLoadingDiv &&
    processExplanationResultDiv &&
    processNameHeading &&
    processOverviewDiv &&
    processStagesDiv &&
    processIODiv &&
    processSignificanceDiv &&
    processErrorDiv
  ) {
    console.log(
      "Biological Process Explainer elements found. Attaching listener."
    );

    explainProcessButton.addEventListener("click", async () => {
      console.log("Explain Process button clicked.");
      const processName = biologicalProcessInput.value.trim();

      if (!processName) {
        displayProcessError("Please enter the name of a biological process.");
        return;
      }

      // Reset UI
      processLoadingDiv.style.display = "block";
      processExplanationResultDiv.style.display = "none"; // Hide main container
      processNameHeading.textContent = "";
      processOverviewDiv.innerHTML = "";
      processStagesDiv.innerHTML = "";
      processIODiv.innerHTML = "";
      processSignificanceDiv.innerHTML = "";
      processErrorDiv.style.display = "none";
      if (processTtsButton) processTtsButton.style.display = "none";

      try {
        console.log("Sending process name for explanation...");
        const response = await fetch("/explain-biological-process", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ process_name: processName }),
        });

        processLoadingDiv.style.display = "none";
        const data = await response.json();

        if (!response.ok) {
          const errorMsg =
            data.error ||
            `HTTP error! status: ${response.status} ${response.statusText}`;
          console.error("Process explanation failed:", errorMsg);
          displayProcessError(errorMsg);
        } else {
          console.log("Process explanation data received:", data);
          displayProcessExplanation(data); // Display the structured data
        }
      } catch (error) {
        console.error(
          "Error during process explanation fetch operation:",
          error
        );
        processLoadingDiv.style.display = "none";
        displayProcessError(
          "A network or unexpected error occurred. Please check the console."
        );
      }
    }); // End button listener
  } else {
    console.log(
      "Biological Process Explainer elements not fully found on this page."
    );
    // Add detailed checks if needed
  }

  // --- Helper function to display the structured process explanation ---
  function displayProcessExplanation(data) {
    if (!data || typeof data !== "object") {
      displayProcessError("Received invalid data format from server.");
      return;
    }

    processNameHeading.textContent =
      data.process_name_explained || "Process Explanation";
    // Use textContent for safety, or a formatting function if HTML lists are expected
    processOverviewDiv.textContent = data.overview || "No overview provided.";

    // Format key_stages as a list
    if (
      data.key_stages &&
      Array.isArray(data.key_stages) &&
      data.key_stages.length > 0
    ) {
      const ul = document.createElement("ul");
      data.key_stages.forEach((stage) => {
        const li = document.createElement("li");
        li.textContent = stage; // Safely set text
        ul.appendChild(li);
      });
      processStagesDiv.innerHTML = ""; // Clear previous
      processStagesDiv.appendChild(ul);
    } else {
      processStagesDiv.textContent =
        "No specific stages listed or process is continuous.";
    }

    processIODiv.textContent =
      data.inputs_outputs || "Inputs/Outputs not specified.";
    processSignificanceDiv.textContent =
      data.significance || "Significance not specified.";

    processExplanationResultDiv.style.display = "block"; // Show the main container

    // Show TTS button if there's content
    // Check if any of the main content divs have text
    const hasContent =
      [data.overview, data.inputs_outputs, data.significance].some(
        (text) => text && text.trim().length > 0
      ) ||
      (data.key_stages && data.key_stages.length > 0);

    if (processTtsButton && hasContent) {
      processTtsButton.style.display = "inline-block";
    }
  }

  // --- Helper function to display process errors ---
  function displayProcessError(errorMessage) {
    if (!processErrorDiv) return;
    processErrorDiv.textContent = `Error: ${errorMessage}`;
    processErrorDiv.className = "result-box error";
    processErrorDiv.style.display = "block";
    // Hide other elements
    if (processExplanationResultDiv)
      processExplanationResultDiv.style.display = "none";
    if (processLoadingDiv) processLoadingDiv.style.display = "none";
    if (processTtsButton) processTtsButton.style.display = "none";
  }

  // === END NEW SECTION ===

  // === NEW SECTION: Flashcard Generator Feature ===
  console.log("Setting up Flashcard Generator feature...");

  const generateFlashcardsButton = document.getElementById(
    "generate-flashcards-button"
  );
  const flashcardSourceTextInput = document.getElementById(
    "flashcard-source-text"
  );
  const flashcardsLoadingDiv = document.getElementById("flashcards-loading");
  const flashcardsResultAreaDiv = document.getElementById(
    "flashcards-result-area"
  );
  const flashcardsListDiv = document.getElementById("flashcards-list");
  const flashcardsErrorDiv = document.getElementById("flashcards-error");

  // Check if elements exist
  if (
    generateFlashcardsButton &&
    flashcardSourceTextInput &&
    flashcardsLoadingDiv &&
    flashcardsResultAreaDiv &&
    flashcardsListDiv &&
    flashcardsErrorDiv
  ) {
    console.log("Flashcard Generator elements found. Attaching listener.");

    generateFlashcardsButton.addEventListener("click", async () => {
      console.log("Generate Flashcards button clicked.");
      const sourceText = flashcardSourceTextInput.value.trim();

      if (!sourceText) {
        displayFlashcardsError(
          "Please enter a topic or text to generate flashcards from."
        );
        return;
      }

      // Reset UI
      flashcardsLoadingDiv.style.display = "block";
      flashcardsResultAreaDiv.style.display = "none"; // Hide main result area
      flashcardsListDiv.innerHTML = ""; // Clear previous list
      flashcardsErrorDiv.style.display = "none"; // Hide previous error

      try {
        console.log("Sending text for flashcard generation...");
        const response = await fetch("/generate-flashcards", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ source_text: sourceText }),
        });

        flashcardsLoadingDiv.style.display = "none";
        const data = await response.json();

        if (!response.ok) {
          const errorMsg =
            data.error ||
            `HTTP error! status: ${response.status} ${response.statusText}`;
          console.error("Flashcard generation failed:", errorMsg);
          displayFlashcardsError(errorMsg);
        } else {
          if (data.flashcards && Array.isArray(data.flashcards)) {
            console.log("Flashcard data received:", data.flashcards);
            if (data.flashcards.length > 0) {
              displayFlashcards(data.flashcards);
              flashcardsResultAreaDiv.style.display = "block"; // Show result area
            } else {
              displayFlashcardsError(
                "No key terms found to generate flashcards for this input."
              );
            }
          } else {
            console.error(
              "Received success but no valid flashcard data structure:",
              data
            );
            displayFlashcardsError(
              "Failed to generate flashcards. The AI response might be malformed."
            );
          }
        }
      } catch (error) {
        console.error("Error during flashcard fetch operation:", error);
        flashcardsLoadingDiv.style.display = "none";
        displayFlashcardsError(
          "A network or unexpected error occurred. Please check the console."
        );
      }
    }); // End button listener
  } else {
    console.log("Flashcard Generator elements not fully found on this page.");
    // Add detailed checks if needed
  }

  // --- Helper function to display the generated flashcards ---
  function displayFlashcards(flashcardData) {
    flashcardsListDiv.innerHTML = ""; // Clear previous list content

    const dl = document.createElement("dl");
    dl.classList.add("flashcard-list"); // Add class for styling

    flashcardData.forEach((card, index) => {
      if (card.term && card.definition) {
        const dt = document.createElement("dt"); // Term
        dt.textContent = card.term;

        const dd = document.createElement("dd"); // Definition
        const definitionTextSpan = document.createElement("span");
        definitionTextSpan.classList.add("flashcard-definition-text");
        definitionTextSpan.textContent = card.definition;
        // Unique ID for the definition text span for TTS targeting
        const definitionId = `flashcard-def-${index}`;
        definitionTextSpan.id = definitionId;

        dd.appendChild(definitionTextSpan);

        // Add individual TTS button for each definition
        if (typeof window.speechSynthesis !== "undefined") {
          // Check TTS support
          const ttsButton = document.createElement("button");
          ttsButton.classList.add("read-aloud-button");
          ttsButton.innerHTML = '🔊 <span class="tts-button-text">Read</span>'; // Text inside span for easier update
          ttsButton.title = `Read definition for "${card.term}" aloud`;
          ttsButton.dataset.target = definitionId; // Target the definition span's ID
          // ttsButton.style.display = 'inline-block'; // Make it visible
          dd.appendChild(ttsButton);
        }

        dl.appendChild(dt);
        dl.appendChild(dd);
      }
    });
    flashcardsListDiv.appendChild(dl);
  }

  // --- Helper function to display flashcard errors ---
  function displayFlashcardsError(errorMessage) {
    if (!flashcardsErrorDiv) return;
    flashcardsErrorDiv.textContent = `Error: ${errorMessage}`;
    flashcardsErrorDiv.className = "result-box error";
    flashcardsErrorDiv.style.display = "block";
    // Hide other elements
    if (flashcardsResultAreaDiv) flashcardsResultAreaDiv.style.display = "none";
    if (flashcardsLoadingDiv) flashcardsLoadingDiv.style.display = "none";
  }

  // === END NEW SECTION ===

  // === NEW SECTION: Chatbot Feature ===
  console.log("Setting up Chatbot feature...");

  const chatbotToggleButton = document.getElementById("chatbot-toggle-button");
  const chatbotWindow = document.getElementById("chatbot-window");
  const chatbotCloseButton = document.getElementById("chatbot-close-button");
  const chatbotMessagesDiv = document.getElementById("chatbot-messages");
  const chatbotInput = document.getElementById("chatbot-input");
  const chatbotSendButton = document.getElementById("chatbot-send-button");

  // Check if essential chatbot elements exist
  if (
    chatbotToggleButton &&
    chatbotWindow &&
    chatbotCloseButton &&
    chatbotMessagesDiv &&
    chatbotInput &&
    chatbotSendButton
  ) {
    console.log("Chatbot elements found. Attaching listeners.");

    // --- Toggle Chat Window ---
    chatbotToggleButton.addEventListener("click", () => {
      const isOpen = chatbotWindow.classList.toggle("open");
      chatbotWindow.style.display = isOpen ? "flex" : "none"; // Use flex for column layout
      if (isOpen) {
        console.log("Chatbot window opened.");
        chatbotInput.focus(); // Focus input when opened
        chatbotToggleButton.innerHTML = '<i class="fas fa-times"></i>'; // Change to close icon
      } else {
        console.log("Chatbot window closed.");
        chatbotToggleButton.innerHTML = '<i class="fas fa-comments"></i>'; // Change back to chat icon
      }
    });

    chatbotCloseButton.addEventListener("click", () => {
      chatbotWindow.classList.remove("open");
      chatbotWindow.style.display = "none";
      chatbotToggleButton.innerHTML = '<i class="fas fa-comments"></i>'; // Change back to chat icon
      console.log("Chatbot window closed via close button.");
    });

    // --- Send Message ---
    async function sendMessage() {
      const userMessage = chatbotInput.value.trim();
      if (!userMessage) return;

      addMessageToChat(userMessage, "user");
      chatbotInput.value = ""; // Clear input
      chatbotInput.disabled = true; // Disable input while waiting
      chatbotSendButton.disabled = true;

      // Add a temporary "typing" indicator for AI
      const thinkingMessageDiv = addMessageToChat(
        "AI is thinking...",
        "ai",
        true
      ); // true for temporary

      try {
        console.log("Sending message to chatbot backend:", userMessage);
        const response = await fetch("/chatbot-message", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: userMessage }),
        });

        // Remove "thinking" message
        if (thinkingMessageDiv && thinkingMessageDiv.parentNode) {
          thinkingMessageDiv.remove();
        }

        if (!response.ok) {
          let errorMsg = `Error: ${response.status}`;
          try {
            const errorData = await response.json();
            errorMsg = errorData.error || errorData.reply || errorMsg;
          } catch (e) {
            /* Ignore if error response isn't JSON */
          }
          addMessageToChat(errorMsg, "ai-error"); // Use a different class for errors
          console.error("Chatbot backend error:", errorMsg);
        } else {
          const data = await response.json();
          addMessageToChat(
            data.reply || "Sorry, I couldn't get a response.",
            "ai"
          );
        }
      } catch (error) {
        console.error("Error sending/receiving chatbot message:", error);
        if (thinkingMessageDiv && thinkingMessageDiv.parentNode) {
          // Ensure removal on network error too
          thinkingMessageDiv.remove();
        }
        addMessageToChat(
          "Network error. Could not reach the AI helper.",
          "ai-error"
        );
      } finally {
        chatbotInput.disabled = false; // Re-enable input
        chatbotSendButton.disabled = false;
        chatbotInput.focus();
      }
    }

    chatbotSendButton.addEventListener("click", sendMessage);
    chatbotInput.addEventListener("keypress", (event) => {
      if (event.key === "Enter") {
        sendMessage();
      }
    });

    // --- Helper to add messages to the chat window ---
    function addMessageToChat(text, type, isTemporary = false) {
      const messageDiv = document.createElement("div");
      messageDiv.classList.add("chat-message", type); // type can be 'user', 'ai', or 'ai-error'
      messageDiv.textContent = text; // Safely set text content
      chatbotMessagesDiv.appendChild(messageDiv);
      chatbotMessagesDiv.scrollTop = chatbotMessagesDiv.scrollHeight; // Scroll to bottom
      if (isTemporary) {
        messageDiv.style.fontStyle = "italic"; // Style temporary messages
      }
      return messageDiv; // Return for potential removal (like "thinking" message)
    }
  } else {
    console.warn(
      "Chatbot UI elements not fully found. Chatbot will not initialize."
    );
    // Log which specific elements are missing for easier debugging
    if (!chatbotToggleButton) console.log("Missing: chatbotToggleButton");
    // ... add checks for other elements ...
  }
  // === END NEW SECTION ===

  // For Physics Simulation
  console.log("Setting up Simulator Launcher...");

  const experimentSelect = document.getElementById("experiment-select");
  const launchButton = document.getElementById("launch-experiment-button");

  if (experimentSelect && launchButton) {
    launchButton.addEventListener("click", () => {
      const selectedValue = experimentSelect.value;
      if (selectedValue) {
        //window.open(selectedValue, "_blank"); // Opens in new tab
        window.location.href = `/simulation/${selectedValue}`;
        console.log("Launching physics experiment:", selectedValue);
      } else {
        alert("Please select an experiment first.");
      }
    });
  } else {
    console.warn("Physics Simulator launcher elements not found.");
  }


  // For Physics Simulation
  console.log("Setting up Simulator Launcher...");

  const chemExperimentSelect = document.getElementById("chem-experiment-select");
  const chemLaunchButton = document.getElementById("launch-chem-experiment-button");

  if (chemExperimentSelect && chemLaunchButton) {
    chemLaunchButton.addEventListener("click", () => {
      const selectedValue = chemExperimentSelect.value;
      if (selectedValue) {
        //window.open(selectedValue, "_blank"); // Opens in new tab
        window.location.href = `/simulation/${selectedValue}`;
        console.log("Launching chemistry experiment:", selectedValue);
      } else {
        alert("Please select an experiment first.");
      }
    });
  } else {
    console.warn("Chemistry Simulator launcher elements not found.");
  }

  console.log("main.js setup complete.");
}); // End DOMContentLoaded Listener
