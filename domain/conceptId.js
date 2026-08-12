const generateConceptID = () => {
    return Math.floor(100000000 + Math.random() * 900000000);
};

module.exports = {
    generateConceptID
};
